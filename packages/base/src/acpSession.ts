// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/acpSession.ts
//
// The shared ACP adapter plumbing used by BOTH the workflow recommender and the
// Gem runner: spawn the adapter binary, bridge stdio via the SDK, build a session,
// set its mode, and pump session updates until the turn stops. The two callers
// differ only in permission policy (deny vs allow) and how they fold updates
// (text-only string vs structured RunResult), so those stay in the callers — this
// module owns the boilerplate that was previously copy-pasted between them.
//
// NEEDS LIVE VALIDATION: stdio bridging against the real ACP adapter (covered by
// the runner + recommender live smokes, since both now route through here).
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import type { McpServer, McpServerStdio } from "@agentclientprotocol/sdk";
export type { McpServer, McpServerStdio } from "@agentclientprotocol/sdk";
import { createLogger } from "./log.js";

const acpLog = createLogger("acp");

// Build an McpServerStdio value (the stdio variant of the McpServer union).
// Converts the env map into the {name, value}[] pairs the SDK expects.
export function stdioMcpServer(name: string, command: string, args: string[], env: Record<string, string> = {}): McpServerStdio {
  return { name, command, args, env: Object.entries(env).map(([k, v]) => ({ name: k, value: v })) };
}

// An ACP adapter to spawn: a display id/name plus the argv to launch it.
// Registry entries also carry the npm package + pinned version that provide the
// bin (used for on-demand install). `env` is an overlay applied at spawn time
// (set by resolveLaunch, e.g. ELECTRON_RUN_AS_NODE on desktop).
export interface AgentDescriptor {
  id: string;
  name: string;
  command: string[];
  package?: string;
  version?: string;
  env?: Record<string, string>;
}

// Provider credentials agentgem stores (in ~/.agentgem/.env) for publish/deploy.
// They must NOT leak into a spawned local agent: every coding-agent CLI (Claude Code,
// codex, …) prefers an explicit API key over its own subscription/ChatGPT login, so an
// inherited key forces pay-as-you-go API billing — hence "credit balance too low" when
// that account is empty. Stripping them makes the local agent authenticate with the
// user's own login, exactly like a normal local invocation. Applies to every ACP
// adapter since they all spawn through connectAcpAdapter.
const AGENT_CREDENTIAL_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY"] as const;

export function localAgentEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of AGENT_CREDENTIAL_VARS) delete out[k];
  return out;
}

// Merge an adapter descriptor's env overlay (e.g. ELECTRON_RUN_AS_NODE) onto a base env.
// The overlay wins over base, so as defense-in-depth we re-strip the provider
// credentials afterwards: a descriptor.env must never reintroduce a key localAgentEnv
// deleted, no matter what a future descriptor producer sets.
export function spawnEnv(descriptor: AgentDescriptor, base: NodeJS.ProcessEnv = localAgentEnv()): NodeJS.ProcessEnv {
  const out = descriptor.env ? { ...base, ...descriptor.env } : { ...base };
  for (const k of AGENT_CREDENTIAL_VARS) delete out[k];
  return out;
}

// A live session over a connected adapter. `prompt` sends one turn and dispatches
// each session_update's `.update` payload to `onUpdate` until the turn stops.
export interface RawAcpSession {
  sessionId: string;
  setMode(mode: string): Promise<void>;
  /** Resolves with the turn's stop reason (e.g. "end_turn", "cancelled") once the agent stops. */
  prompt(text: string, onUpdate: (update: unknown) => void): Promise<string | undefined>;
  /** Fire-and-forget ACP session/cancel — the in-flight prompt then ends with stopReason "cancelled". */
  cancel(): void;
  dispose(): void;
}
// What the agent told us at initialize: protocol version + advertised capabilities.
// Callers gate optional methods (session/load, session/resume) on this instead of
// probing-and-catching. Kept loose (Record) — the ACP capability surface is still
// growing and we only ever read specific keys.
export interface AcpAgentInfo {
  protocolVersion?: number;
  capabilities: { loadSession?: boolean; sessionCapabilities?: { resume?: object | null } } & Record<string, unknown>;
  agentName?: string;
}
// Omitted/null means "not supported"; `{}` means supported (ACP capability convention).
export function supportsLoadSession(info: AcpAgentInfo): boolean {
  return info.capabilities.loadSession === true;
}
export function supportsResumeSession(info: AcpAgentInfo): boolean {
  const r = info.capabilities.sessionCapabilities?.resume;
  return r !== undefined && r !== null;
}

export interface RawAcpConnection {
  info: AcpAgentInfo;
  open(cwd: string, opts?: { mcpServers?: McpServer[] }): Promise<RawAcpSession>;
  /** Attach to a previously-created session (session/resume, else session/load).
   * Throws { code: "resume_unsupported" } when the agent advertises neither.
   * CAVEAT: the returned session's update routing is keyed by sessionId (see
   * `externalUpdates` below), so two concurrent prompt() calls against the SAME
   * resumed sessionId would clobber each other's handler. Not reachable today —
   * ChatManager serializes turns per chat — but callers of openExisting MUST
   * continue to serialize turns on a given sessionId. */
  openExisting(cwd: string, sessionId: string, opts?: { mcpServers?: McpServer[] }): Promise<RawAcpSession>;
  close(): void;
}

export interface ConnectAdapterOptions {
  clientName: string;
  // Auto-response to session/request_permission: "deny" cancels every request
  // (recommender, read-only); "allow" approves them (runner, tool-capable).
  permission: "allow" | "deny";
  // Shutdown ladder pacing (tests shrink these): stdin end → SIGTERM after termMs →
  // SIGKILL after another killMs. Defaults 1500/1000.
  shutdown?: { termMs?: number; killMs?: number };
}

// Rolling stderr evidence: keep only the LAST `max` chars so a chatty adapter can't
// grow memory, while the tail (where the fatal error lands) is always preserved.
// Borrowed from acpx's bounded startup-stderr capture.
export function boundedTail(prev: string, chunk: string, max = 4096): string {
  const joined = prev + chunk;
  return joined.length <= max ? joined : joined.slice(joined.length - max);
}

export async function connectAcpAdapter(
  descriptor: AgentDescriptor,
  opts: ConnectAdapterOptions,
): Promise<RawAcpConnection> {
  const { client, ndJsonStream, PROTOCOL_VERSION } = await import("@agentclientprotocol/sdk");
  const [bin, ...args] = descriptor.command;
  const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], env: spawnEnv(descriptor) });
  // Capture the adapter's stderr rather than inheriting it (crash dumps must not
  // pollute server logs) AND keep a bounded rolling tail so a startup failure can
  // say WHY the adapter died instead of a generic exit code.
  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderrTail = boundedTail(stderrTail, text);
    const trimmed = text.trimEnd();
    if (trimmed) acpLog.debug(`[${bin}] ${trimmed}`);
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", (e) => reject(new Error(`failed to spawn ${bin}: ${e.message}`)));
  });

  // Detect the adapter dying mid-session. Without this, a crashed child (e.g. EPIPE) leaves prompt()'s
  // `await session.nextUpdate()` waiting on a message that will never arrive — the turn hangs forever and
  // the SSE stream stays stuck at "running". `dead` rejects on exit/error so the prompt loop can race it.
  let died: Error | null = null;
  let signalDead: (e: Error) => void = () => {};
  const dead = new Promise<never>((_, reject) => { signalDead = reject; });
  dead.catch(() => {}); // consumed via Promise.race; pre-attach so Node doesn't flag an unhandled rejection
  const markDead = (e: Error) => {
    if (!died) {
      const tail = stderrTail.trim();
      // Include the stderr tail in the error message; consuming surfaces are loopback-guarded local console
      // and local gem-run outcomes (same user, same machine). Provider credentials were stripped at spawn via
      // localAgentEnv, so the tail is the user's own local crash output — richness beats redaction here.
      died = tail ? new Error(`${e.message}\nadapter stderr: ${tail}`) : e;
      signalDead(died);
    }
  };
  child.once("exit", (code, signal) => markDead(new Error(`agent process exited (code ${code ?? "null"}, signal ${signal ?? "null"})`)));
  child.once("error", (e) => markDead(new Error(`agent process error: ${e.message}`)));
  // stdout EOF (child closes its write end, e.g. by exiting) reaches the SDK's own
  // ndjson reader — via the `Readable.toWeb(child.stdout!)` wrap below — before the
  // ChildProcess "exit" event fires, and the SDK reacts by rejecting every pending
  // request with a generic "ACP connection closed", losing the stderr evidence.
  // Registering our own "end" listener on the raw stream here, BEFORE it's wrapped,
  // wins that race: Node invokes listeners for the same event in registration
  // order, so this synchronous handler populates `died` (and calls signalDead)
  // before the SDK's wrapper even observes the EOF. Note: exit/stdout-end fire before
  // all buffered stderr chunks may be delivered (stdio pipes have no cross-stream ordering),
  // so the tail may occasionally be incomplete — accepted tradeoff over delay-to-death.
  child.stdout?.once("end", () => markDead(new Error(`agent process exited (code ${child.exitCode ?? "null"}, signal ${child.signalCode ?? "null"})`)));
  const app: any = client({ name: opts.clientName });
  const reply = opts.permission === "allow"
    ? { outcome: { outcome: "selected", optionId: "allow" } }
    : { outcome: { outcome: "cancelled" } };
  app.onRequest?.("session/request_permission", async () => reply);
  // Update routing for sessions attached via session/resume or session/load — the
  // SDK's ActiveSession queue only wraps session/new. One connection-level handler
  // dispatches by sessionId; a session with no registered handler (e.g. the history
  // replay session/load streams before its first prompt) is deliberately dropped —
  // the console restores display history from the transcript instead.
  // NOT SAFE for two concurrent prompt() calls on the same sessionId — the single
  // per-sessionId slot means the second call's handler registration overwrites the
  // first's (see openExisting's prompt(), which set()s/delete()s this on each turn).
  // Unreachable today because ChatManager serializes turns per chat; any future
  // caller of openExisting must preserve that same per-sessionId serialization.
  const externalUpdates = new Map<string, (update: unknown) => void>();
  // The handler receives an SDK context object ({ params, signal, agent }), NOT the raw
  // notification params directly — confirmed against node_modules/@agentclientprotocol/sdk's
  // registerAppNotification (context() wraps params before invoking the handler).
  app.onNotification?.("session/update", (ctx: any) => {
    const sid = ctx?.params?.sessionId as string | undefined;
    if (sid) externalUpdates.get(sid)?.(ctx.params.update);
  });
  const input = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
  const output = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
  const connection: any = app.connect(ndJsonStream(output, input));
  const agentCtx: any = connection.agent;
  // ACP requires an `initialize` handshake before any session/new. claude-agent-acp
  // tolerated skipping it; codex-acp strictly rejects session/new with "Not
  // initialized" (-32603) without it. We advertise no client capabilities we don't
  // implement (no fs/terminal handlers) — both adapters write files directly.
  const init: any = await Promise.race([agentCtx.request("initialize", { protocolVersion: PROTOCOL_VERSION }), dead]);
  const info: AcpAgentInfo = {
    protocolVersion: init?.protocolVersion,
    capabilities: (init?.agentCapabilities ?? {}) as AcpAgentInfo["capabilities"],
    agentName: init?.agentInfo?.name,
  };
  acpLog.debug(`[${bin}] initialized: protocol=${info.protocolVersion} agent=${info.agentName ?? "?"} loadSession=${supportsLoadSession(info)} resume=${supportsResumeSession(info)}`);

  return {
    info,
    async open(cwd: string, opts?: { mcpServers?: McpServer[] }) {
      try { mkdirSync(cwd, { recursive: true }); } catch { /* best-effort */ }
      let builder: any = agentCtx.buildSession(cwd);
      for (const s of opts?.mcpServers ?? []) builder = builder.withMcpServer(s);
      const session: any = await Promise.race([builder.start(), dead]);
      const sessionId = session.sessionId as string;
      return {
        sessionId,
        async setMode(mode: string) {
          try { await agentCtx.request("session/set_mode", { sessionId, modeId: mode }); } catch { /* best-effort */ }
        },
        async prompt(text: string, onUpdate: (update: unknown) => void) {
          if (died) throw died; // session already dead — fail fast instead of hanging
          void session.prompt(text);
          for (;;) {
            // Race the next update against child death so a crashed adapter rejects here, not hangs.
            const msg: any = await Promise.race([session.nextUpdate(), dead]);
            if (msg.kind === "stop") return msg.response?.stopReason as string | undefined;
            if (msg.kind === "session_update") onUpdate(msg.update);
          }
        },
        cancel() {
          // A notification, not a request: the agent may still emit final updates, then the running
          // prompt ends with stopReason "cancelled" (ACP spec). Never awaited against the turn.
          void agentCtx.notify("session/cancel", { sessionId }).catch(() => {});
        },
        dispose() { try { session.dispose?.(); } catch { /* ignore */ } },
      };
    },
    async openExisting(cwd: string, sessionId: string, opts?: { mcpServers?: McpServer[] }) {
      if (died) throw died;
      // Capability-gated ladder (acpx): session/resume (no history replay — cheapest)
      // → session/load (agent replays history; we drop it, transcript restore already
      // rendered it) → typed refusal the caller can fall back on.
      if (supportsResumeSession(info)) {
        await Promise.race([agentCtx.request("session/resume", { sessionId, cwd, mcpServers: opts?.mcpServers ?? [] }), dead]);
      } else if (supportsLoadSession(info)) {
        await Promise.race([agentCtx.request("session/load", { sessionId, cwd, mcpServers: opts?.mcpServers ?? [] }), dead]);
      } else {
        throw Object.assign(new Error(`${descriptor.id} supports neither session/resume nor session/load`), { code: "resume_unsupported" });
      }
      return {
        sessionId,
        async setMode(mode: string) {
          try { await agentCtx.request("session/set_mode", { sessionId, modeId: mode }); } catch { /* best-effort */ }
        },
        async prompt(text: string, onUpdate: (update: unknown) => void) {
          if (died) throw died;
          externalUpdates.set(sessionId, onUpdate);
          try {
            const resp: any = await Promise.race([
              agentCtx.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }),
              dead,
            ]);
            return resp?.stopReason as string | undefined;
          } finally {
            externalUpdates.delete(sessionId);
          }
        },
        cancel() {
          void agentCtx.notify("session/cancel", { sessionId }).catch(() => {});
        },
        dispose() { externalUpdates.delete(sessionId); },
      };
    },
    close: (() => {
      let closed = false;
      return () => {
        if (closed) return;
        closed = true;
        try { connection.close(); } catch { /* ignore */ }
        // Graceful shutdown ladder (borrowed from acpx): stdin end() is the cleanest
        // signal for a stdio ACP agent (EOF on its read loop) — most adapters exit on
        // it. SIGTERM catches ones that don't; SIGKILL catches ones that trap SIGTERM.
        // Timers are unref'd so a wedged adapter can't keep the server process alive.
        if (died || child.exitCode !== null) { try { child.kill("SIGKILL"); } catch { /* already gone */ } return; }
        const termMs = opts.shutdown?.termMs ?? 1500;
        const killMs = opts.shutdown?.killMs ?? 1000;
        try { child.stdin?.end(); } catch { /* ignore */ }
        const term = setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* ignore */ } }, termMs);
        const kill = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, termMs + killMs);
        (term as { unref?: () => void }).unref?.();
        (kill as { unref?: () => void }).unref?.();
        child.once("exit", () => { clearTimeout(term); clearTimeout(kill); });
      };
    })(),
  };
}
