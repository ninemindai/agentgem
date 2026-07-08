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
export function spawnEnv(descriptor: AgentDescriptor, base: NodeJS.ProcessEnv = localAgentEnv()): NodeJS.ProcessEnv {
  return descriptor.env ? { ...base, ...descriptor.env } : { ...base };
}

// A live session over a connected adapter. `prompt` sends one turn and dispatches
// each session_update's `.update` payload to `onUpdate` until the turn stops.
export interface RawAcpSession {
  setMode(mode: string): Promise<void>;
  prompt(text: string, onUpdate: (update: unknown) => void): Promise<void>;
  dispose(): void;
}
export interface RawAcpConnection {
  open(cwd: string, opts?: { mcpServers?: McpServer[] }): Promise<RawAcpSession>;
  close(): void;
}

export interface ConnectAdapterOptions {
  clientName: string;
  // Auto-response to session/request_permission: "deny" cancels every request
  // (recommender, read-only); "allow" approves them (runner, tool-capable).
  permission: "allow" | "deny";
}

export async function connectAcpAdapter(
  descriptor: AgentDescriptor,
  opts: ConnectAdapterOptions,
): Promise<RawAcpConnection> {
  const { client, ndJsonStream, PROTOCOL_VERSION } = await import("@agentclientprotocol/sdk");
  const [bin, ...args] = descriptor.command;
  const child = spawn(bin, args, { stdio: ["pipe", "pipe", "inherit"], env: spawnEnv(descriptor) });
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
  const markDead = (e: Error) => { if (!died) { died = e; signalDead(e); } };
  child.once("exit", (code, signal) => markDead(new Error(`agent process exited (code ${code ?? "null"}, signal ${signal ?? "null"})`)));
  child.once("error", (e) => markDead(new Error(`agent process error: ${e.message}`)));
  const app: any = client({ name: opts.clientName });
  const reply = opts.permission === "allow"
    ? { outcome: { outcome: "selected", optionId: "allow" } }
    : { outcome: { outcome: "cancelled" } };
  app.onRequest?.("session/request_permission", async () => reply);
  const input = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
  const output = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
  const connection: any = app.connect(ndJsonStream(output, input));
  const agentCtx: any = connection.agent;
  // ACP requires an `initialize` handshake before any session/new. claude-agent-acp
  // tolerated skipping it; codex-acp strictly rejects session/new with "Not
  // initialized" (-32603) without it. We advertise no client capabilities we don't
  // implement (no fs/terminal handlers) — both adapters write files directly.
  await agentCtx.request("initialize", { protocolVersion: PROTOCOL_VERSION });

  return {
    async open(cwd: string, opts?: { mcpServers?: McpServer[] }) {
      try { mkdirSync(cwd, { recursive: true }); } catch { /* best-effort */ }
      let builder: any = agentCtx.buildSession(cwd);
      for (const s of opts?.mcpServers ?? []) builder = builder.withMcpServer(s);
      const session: any = await builder.start();
      const sessionId = session.sessionId as string;
      return {
        async setMode(mode: string) {
          try { await agentCtx.request("session/set_mode", { sessionId, modeId: mode }); } catch { /* best-effort */ }
        },
        async prompt(text: string, onUpdate: (update: unknown) => void) {
          if (died) throw died; // session already dead — fail fast instead of hanging
          void session.prompt(text);
          for (;;) {
            // Race the next update against child death so a crashed adapter rejects here, not hangs.
            const msg: any = await Promise.race([session.nextUpdate(), dead]);
            if (msg.kind === "stop") break;
            if (msg.kind === "session_update") onUpdate(msg.update);
          }
        },
        dispose() { try { session.dispose?.(); } catch { /* ignore */ } },
      };
    },
    close: () => {
      try { connection.close(); } catch { /* ignore */ }
      try { child.kill(); } catch { /* ignore */ }
    },
  };
}
