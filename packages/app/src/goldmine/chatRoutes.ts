// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/goldmine/chatRoutes.ts
//
// REST + SSE endpoints for the goldmine chat tab. Four routes:
//   GET  /api/agents            → { agents: AgentAvailability[] }
//   POST /api/chat              body: { agentId } → { chatId }
//   GET  /api/chat/stream       ?chatId&message   → SSE ChatEvent stream
//   DELETE /api/chat/:chatId    → { ok: true }
//
// The real chatConnectFn is co-located here; it mirrors connectRunSession (acpRun.ts)
// but uses permission:"deny" and clientName "agentgem-chat" so the chat agent can
// inspect the goldmine MCP tools but not auto-approve arbitrary shell commands.
//
// Express types are duck-typed (no @types/express import) to match the pattern used
// by originGuard and the raw SSE handlers (gemRunStream, insightsStream).
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { connectAcpAdapter, stdioMcpServer, resolveLaunch, adapterRuntimeCtx, AGENTS, ensureAdapter } from "@agentgem/base";
import type { AgentAvailability, AgentDescriptor, McpServerStdio, AdapterCtx, AdapterInstaller } from "@agentgem/base";
import { createAccumulator, applyUpdate } from "@agentgem/run";
import { studioCwd } from "@agentgem/play";
import type { ChatManager, ChatConnectFn, ChatCtx, ChatEvent, ChatSessionHandle, ToolInvocation } from "@agentgem/run";
import { draftGemFromChat } from "./draftGem.js";
import { createAguiMapper } from "./aguiStream.js";
import type { AguiEvent } from "./aguiStream.js";

// Duck-typed Express request/response so this file carries no @types/express dependency.
interface Req {
  body?: Record<string, unknown>;
  query: Record<string, unknown>;
  params: Record<string, string>;
}
interface Res {
  status(code: number): Res;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
  write(chunk: string): void;
  end(): void;
}
// Minimal Express middleware shape (same duck-typing as originGuard.ts).
type Middleware = (req: Req, res: Res, next: () => void) => void;
// Express app interface — just the subset of methods we call.
interface App {
  get(path: string, guard: Middleware, handler: (req: Req, res: Res) => void): void;
  post(path: string, guard: Middleware, handler: (req: Req, res: Res) => Promise<void>): void;
  delete(path: string, guard: Middleware, handler: (req: Req, res: Res) => void): void;
}

export interface ChatRouteDeps {
  manager: ChatManager;
  listAgents: () => AgentAvailability[];
  buildBrief: () => Promise<string>;
  goldmineMcp: () => McpServerStdio[];
  // Studio mode: resolve a miniapp NAME to a validated cwd (its registry dir) + a studio brief. The
  // resolver validates the name (rejects anything that isn't a clean segment); when absent, chat runs
  // in the neutral cwd with the neutral brief.
  resolveStudio?: (miniapp: string) => { cwd: string; brief: string };
  // Project launch: resolve a project ROOT (raw path from the body) to a VALIDATED canonical
  // cwd, or null if it isn't in the server's discovered/recent allow-list. Absent → unavailable.
  resolveProjectCwd?: (root: string) => string | null;
  // The neutral cwd (agentgemHome()/.agentgem/chat) — where a chat with no `project` and no
  // `miniapp` must always run. Passed explicitly so a neutral session never depends on
  // process.cwd() (which may itself be an allow-listed project and get mistaken for one).
  neutralCwd: string;
  // Install a missing adapter on demand (CLI only). Throws an error carrying
  // code:"consent_required" when consent is absent; the route maps that to 409.
  installAgent?: (id: string, consent: boolean) => Promise<{ available: boolean; source: string; needsLogin: boolean }>;
  // Studio auto-checkpoint: commit the miniapp's on-disk state after a successful turn (durability).
  // Injected so the route stays testable without the real registry. Absent → checkpointing is a no-op.
  checkpointMiniapp?: (name: string) => Promise<unknown>;
}

// Pure mapping of a POST /api/chat body to ChatManager.openChat args — extracted so the studio-vs-neutral
// branch is unit-testable without driving Express. A `miniapp` (name) routes the session into that
// miniapp's validated dir with a studio brief; otherwise the neutral brief and no cwd override.
export async function studioChatArgs(
  body: { agentId?: unknown; miniapp?: unknown; project?: unknown; resume?: unknown },
  deps: Pick<ChatRouteDeps, "buildBrief" | "goldmineMcp" | "resolveStudio" | "resolveProjectCwd" | "neutralCwd">,
): Promise<{ agentId: string; brief: string; mcpServers: McpServerStdio[]; cwd?: string; permission?: "allow" | "deny"; resumeSessionId?: string }> {
  const agentId = String(body?.agentId ?? "");
  if (!agentId) throw new Error("agentId required");
  const miniapp = body?.miniapp ? String(body.miniapp) : "";
  const project = body?.project ? String(body.project) : "";
  if (miniapp && project) throw new Error("miniapp and project are mutually exclusive");
  // SECURITY: `resume` is a client-supplied ACP sessionId. It never touches the fs —
  // the adapter resolves it in its OWN session store. Cwd/session binding on resume
  // is a per-ADAPTER trust assumption, not something the ACP spec mandates (to be
  // confirmed against real adapters in the live smoke) — a sessionId from another
  // project may or may not fail at the adapter depending on how strictly that
  // adapter enforces cwd match. Either way the worst case is bounded here: the
  // session opens under the SERVER-derived cwd (resolveChatCwd re-guard) and the
  // permission set by this route — never by the client — so a mismatched resume
  // can misattach a session but cannot escalate access or redirect the filesystem.
  const resumeSessionId = typeof body?.resume === "string" && body.resume ? body.resume : undefined;
  if (miniapp) {
    if (!deps.resolveStudio) throw new Error("studio not available");
    // Built-ins are served constants with no registry entry — resolveStudio would ENOENT on their
    // meta.json (the "__repo-pulse" 500, 2026-07-21). The "invalid miniapp name" prefix rides the
    // route's existing client-error mapping to a 400.
    if (miniapp.startsWith("__")) {
      throw new Error(`invalid miniapp name: "${miniapp}" is a built-in (served constant) — it can't be edited`);
    }
    const s = deps.resolveStudio(miniapp); // resolver validates the name; throws on a bad one
    // "allow" so the studio agent can Edit/Write the miniapp; its cwd is jailed to the miniapp dir.
    return { agentId, brief: s.brief, mcpServers: deps.goldmineMcp(), cwd: s.cwd, permission: "allow", ...(resumeSessionId ? { resumeSessionId } : {}) };
  }
  if (project) {
    if (!deps.resolveProjectCwd) throw new Error("project launch not available");
    const cwd = deps.resolveProjectCwd(project); // validates against the allow-list
    if (!cwd) throw new Error("unknown project");
    // Neutral brief + normal permission: a project chat is not a studio session and must not
    // silently gain write access to the real repo.
    return { agentId, brief: await deps.buildBrief(), mcpServers: deps.goldmineMcp(), cwd, ...(resumeSessionId ? { resumeSessionId } : {}) };
  }
  return { agentId, brief: await deps.buildBrief(), mcpServers: deps.goldmineMcp(), cwd: deps.neutralCwd, ...(resumeSessionId ? { resumeSessionId } : {}) };
}

// The connectFn re-guard (defense-in-depth): honor `requested` if studioCwd accepts it
// (miniapp path or the neutral cwd) OR if it's an allow-listed project; else neutral cwd.
export function resolveChatCwd(requested: string, chatCwd: string, resolveProjectCwd?: (root: string) => string | null): string {
  if (resolve(requested) === resolve(chatCwd)) return chatCwd; // neutral — no scan, always neutral
  const viaStudio = studioCwd(requested, chatCwd);
  if (resolve(viaStudio) !== resolve(chatCwd)) return viaStudio; // a valid miniapp path
  return resolveProjectCwd?.(requested) ?? chatCwd; // validated project, else neutral
}

// Build the installAgent dep for registerChatRoutes: look the id up in AGENTS, run
// ensureAdapter, and attach a static "needs login on first use" hint (auth is the
// adapter's job — see spec: availability-only scope).
export function installAgentFn(ctx: AdapterCtx, install: AdapterInstaller) {
  return async (id: string, consent: boolean) => {
    const descriptor = AGENTS.find((a) => a.id === id);
    if (!descriptor) throw new Error(`unknown agent: ${id}`);
    const res = await ensureAdapter(descriptor, ctx, { consent, install });
    return { available: res.available, source: res.source, needsLogin: true };
  };
}

// No-op guard used when originGuard is not provided (e.g. in tests that call
// registerChatRoutes directly on a bare app without the CSRF middleware layer).
const noopGuard: Middleware = (_req, _res, next) => next();

export function registerChatRoutes(app: App, deps: ChatRouteDeps, guard: Middleware = noopGuard): void {
  // chatId → miniapp name, for studio sessions only. Lets the turn-end handler know which miniapp to
  // checkpoint. Populated on open, cleared on close. A leaked short string is harmless; we tidy anyway.
  const chatMiniapps = new Map<string, string>();

  // GET /api/agents — list which agents are on PATH
  app.get("/api/agents", guard, (_req, res) => {
    res.json({ agents: deps.listAgents() });
  });

  // POST /api/agents/:id/install — install a missing adapter on demand (CLI).
  app.post("/api/agents/:id/install", guard, async (req, res) => {
    const id = req.params.id;
    const consent = Boolean((req.body ?? {}).consent);
    if (!deps.installAgent) { res.status(400).json({ error: "install not supported on this runtime" }); return; }
    try {
      const result = await deps.installAgent(id, consent);
      res.json(result);
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === "consent_required") { res.status(409).json({ error: err.message, code: "consent_required" }); return; }
      if (/no install source|unknown agent/i.test(err.message)) { res.status(400).json({ error: err.message }); return; }
      // Log the raw error (paths, subprocess command lines, package-manager output) server-side only;
      // return a generic message so an unclassified install failure can't disclose internals.
      console.error(`agent install failed for ${id}:`, err.message);
      res.status(500).json({ error: "install failed" });
    }
  });

  // POST /api/chat — open a new chat session; request-derived value is only agentId
  app.post("/api/chat", guard, async (req, res) => {
    try {
      // SECURITY: mcpServers is server-derived (goldmineMcp()). The only two cwd overrides are
      // `miniapp` (a NAME resolved server-side via deps.resolveStudio → miniappDir, which rejects
      // bad names) and `project` (a PATH validated against deps.resolveProjectCwd's discovered/recent
      // allow-list). No raw path from the request body is ever trusted as cwd directly.
      const args = await studioChatArgs(req.body ?? {}, deps);
      const chatId = await deps.manager.openChat(args);
      const miniapp = req.body?.miniapp ? String(req.body.miniapp) : "";
      if (miniapp) chatMiniapps.set(chatId, miniapp);
      const st = deps.manager.stateOf(chatId);
      res.json({ chatId, sessionId: st.alive ? st.sessionId : "", agent: args.agentId, resumed: st.alive ? st.resumed : false });
    } catch (e) {
      const msg = (e as Error).message;
      // Client errors (missing agentId, a bad/unknown miniapp or project) → 400; anything else → 500.
      const clientErr = msg === "agentId required" || msg === "studio not available"
        || msg.startsWith("invalid miniapp name")
        || msg === "unknown project" || msg === "project launch not available"
        || msg === "miniapp and project are mutually exclusive";
      res.status(clientErr ? 400 : 500).json({ error: msg });
    }
  });

  // ── Turn engine: POST-then-stream transport (2026-07-20 eng review, issue 10) ──────────────
  // The message travels in a POST body — no EventSource query-string/URL-length ceiling — and the
  // SSE stream attaches by turnId, replaying buffered events before following live. The turn
  // drains to completion inside startTurn regardless of whether a stream ever attaches (the
  // background-completion guarantee R1 that used to live inline in the GET handler), which is
  // also what lets a late or reconnecting client attach mid-turn and see the full history.
  //
  //   POST /api/chat/turn {chatId,message} ─▶ startTurn ─▶ drain sendMessage ─▶ events[] + wake
  //                              │ {turnId}                    (checkpoint runs BEFORE `done`
  //   GET /api/chat/stream?chatId&turnId ─▶ attach: replay events[0..] ─▶ await wake ─▶ … done
  //   GET /api/chat/stream?chatId&message ─▶ legacy entrance: mints the turn itself, then attaches
  interface LiveTurn { chatId: string; events: ChatEvent[]; done: boolean; wake: Set<() => void> }
  const liveTurns = new Map<string, LiveTurn>();
  const TURN_TTL_MS = 10 * 60_000; // the buffer survives briefly past done for a late re-attach

  const startTurn = (chatId: string, message: string): string => {
    const turnId = randomUUID();
    const turn: LiveTurn = { chatId, events: [], done: false, wake: new Set() };
    liveTurns.set(turnId, turn);
    const bump = () => { const ws = [...turn.wake]; turn.wake.clear(); for (const w of ws) w(); };
    void (async () => {
      const miniapp = chatMiniapps.get(chatId);
      try {
        for await (const ev of deps.manager.sendMessage(chatId, message)) {
          // Checkpoint BEFORE the done event becomes visible to any attached stream (2026-07-20
          // eng review, issue 6): the client may auto-fire a queued next turn the moment it sees
          // `done`, and that turn's edits must not race this turn's durability commit. A
          // checkpoint failure is logged and swallowed — it must never turn a successful turn
          // into a failed one, and `done` is buffered regardless.
          if (ev.type === "done" && miniapp && deps.checkpointMiniapp) {
            try { await deps.checkpointMiniapp(miniapp); }
            catch (e) { console.error(`checkpoint failed for miniapp ${miniapp}:`, (e as Error).message); }
          }
          turn.events.push(ev); bump();
        }
      } catch (e) {
        // A generator throw becomes a buffered `failed` event — attached streams (native or AG-UI,
        // whose mapper routes `failed` to RUN_ERROR) forward it like any other frame.
        turn.events.push({ type: "failed", error: (e as Error).message }); bump();
      }
      turn.done = true; bump();
      const t = setTimeout(() => liveTurns.delete(turnId), TURN_TTL_MS);
      (t as { unref?: () => void }).unref?.();
    })();
    return turnId;
  };

  // POST /api/chat/turn — start a turn with the message in the BODY; stream it via
  // GET /api/chat/stream?chatId&turnId. A turn started while another runs still mints a turn —
  // its stream immediately forwards the manager's "already running" failure, the same contract
  // the legacy entrance always had.
  app.post("/api/chat/turn", guard, async (req, res) => {
    const { chatId, message } = (req.body ?? {}) as { chatId?: unknown; message?: unknown };
    if (typeof chatId !== "string" || typeof message !== "string" || !message.trim()) {
      res.status(400).json({ error: "chatId and message are required" }); return;
    }
    if (!deps.manager.stateOf(chatId).alive) { res.status(404).json({ error: "unknown chat" }); return; }
    res.json({ turnId: startTurn(chatId, message) });
  });

  // GET /api/chat/stream — attach to a turn's SSE stream. Two entrances, one engine:
  //   ?chatId&turnId   — attach to a POST-started turn (console path)
  //   ?chatId&message  — legacy: mint the turn here, then attach (kept for external AG-UI
  //                      consumers; small messages only — the query string caps at header size)
  app.get("/api/chat/stream", guard, async (req, res) => {
    const chatId = String(req.query.chatId ?? "");
    const turnIdParam = String(req.query.turnId ?? "");
    const turnId = turnIdParam || startTurn(chatId, String(req.query.message ?? ""));
    const turn = liveTurns.get(turnId);
    if (!turn || turn.chatId !== chatId) { res.status(404).json({ error: "unknown turn" }); return; }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("Connection", "keep-alive");

    // Per-event forwarder: native `event:`-typed frames, or AG-UI translation when opted in (the
    // event type lives inside the JSON payload, no `event:` line, per the AG-UI SSE convention).
    // A write failure means the client disconnected — swallowed, because the turn's drain lives in
    // startTurn and MUST NOT be tied to this socket (R1).
    let forward: (ev: ChatEvent) => void;
    if (String(req.query.protocol ?? "") === "ag-ui") {
      const mapper = createAguiMapper({ threadId: chatId, runId: randomUUID(), genId: () => randomUUID() });
      const emit = (e: AguiEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
      try { for (const e of mapper.start()) emit(e); } catch { /* client gone */ }
      forward = (ev) => { try { for (const e of mapper.onChat(ev)) emit(e); } catch { /* client gone */ } };
    } else {
      forward = (ev) => { try { res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`); } catch { /* client gone */ } };
    }

    let i = 0;
    for (;;) {
      while (i < turn.events.length) forward(turn.events[i++]);
      if (turn.done) break;
      await new Promise<void>((r) => turn.wake.add(r));
    }
    try { res.end(); } catch { /* client already disconnected */ }
  });

  // POST /api/chat/:chatId/draft-gem — drive one selection turn and return a built Gem.
  // Returns JSON { selection, gem, dropped } on success or { error } on failure.
  // NOTE: result is returned directly to the client; there is no persistent Curate
  // draft store in this repo. A Curate deep-link integration can be added later.
  app.post("/api/chat/:chatId/draft-gem", guard, async (req, res) => {
    const result = await draftGemFromChat({ manager: deps.manager }, req.params.chatId);
    if ("error" in result) {
      res.status(500).json(result);
    } else {
      res.json(result);
    }
  });

  // POST /api/chat/:chatId/cancel — interrupt the running turn (ACP session/cancel); the session
  // stays alive and the turn's own stream finishes with done + stopReason "cancelled". Idle chat →
  // { cancelled: false } (interrupting an already-finished turn is a no-op, never an error).
  app.post("/api/chat/:chatId/cancel", guard, async (req, res) => {
    if (!deps.manager.stateOf(req.params.chatId).alive) { res.status(404).json({ error: "unknown chat" }); return; }
    res.json({ cancelled: deps.manager.cancelChat(req.params.chatId) });
  });

  // DELETE /api/chat/:chatId — close + evict the session
  app.delete("/api/chat/:chatId", guard, (req, res) => {
    deps.manager.closeChat(req.params.chatId);
    chatMiniapps.delete(req.params.chatId);
    res.json({ ok: true });
  });

  // GET /api/chat/:chatId/state — liveness for client reconciliation after navigation/reload.
  // { alive:false } if the session was swept/evicted or the core restarted.
  app.get("/api/chat/:chatId/state", guard, (req, res) => {
    res.json(deps.manager.stateOf(req.params.chatId));
  });
}

// ── Real chatConnectFn ────────────────────────────────────────────────────────
// Mirrors connectRunSession (acpRun.ts) but:
//   • permission:"deny"  — auto-deny tool confirmations (read-only goldmine MCP
//     passes through because it owns its own permissions; deny blocks shell escape)
//   • clientName "agentgem-chat"
//
// SECURITY: this is the only place we call connectAcpAdapter for chat; the
// session handle that comes back is handed to ChatManager.openChat(), which
// opens it in a server-derived cwd. Request input never reaches connectAcpAdapter.
// Build a chat connect fn that first resolves the descriptor's bare command into an
// absolute launch plan (PATH → managed dir → bundled), then connects. The rewrite is
// the same seam sandbox.ts uses. `resolve` is injected so tests can supply a fake and
// desktop/cli share one default (adapterRuntimeCtx() auto-detects the runtime).
export function makeChatConnectFn(resolve: (d: AgentDescriptor) => AgentDescriptor): ChatConnectFn {
  return async (descriptor: AgentDescriptor, opts) => {
    const launch = resolve(descriptor);
    // Default "deny" (read-only goldmine chat); the studio passes "allow" so the agent can edit its miniapp.
    const raw = await connectAcpAdapter(launch, { clientName: "agentgem-chat", permission: opts?.permission ?? "deny" });
    const ctx: ChatCtx = {
      async open(cwd: string, openOpts?: { mcpServers?: unknown[] }): Promise<ChatSessionHandle> {
        const session = await raw.open(cwd, { mcpServers: openOpts?.mcpServers as never });
        return {
          sessionId: session.sessionId,
          setMode: (m: string) => session.setMode(m),
          async prompt(text: string, onDelta?: (c: string) => void, onToolCall?: (t: ToolInvocation) => void) {
            const acc = createAccumulator();
            const stopReason = await session.prompt(text, (u) =>
              applyUpdate(acc, (u ?? {}) as Parameters<typeof applyUpdate>[1], { onDelta, onToolCall }),
            );
            return { ...acc, stopReason };
          },
          cancel: () => session.cancel(),
          dispose: () => session.dispose(),
        };
      },
      async openExisting(cwd: string, sessionId: string, openOpts?: { mcpServers?: unknown[] }): Promise<ChatSessionHandle> {
        const session = await raw.openExisting(cwd, sessionId, { mcpServers: openOpts?.mcpServers as never });
        return {
          sessionId: session.sessionId,
          setMode: (m: string) => session.setMode(m),
          async prompt(text: string, onDelta?: (c: string) => void, onToolCall?: (t: ToolInvocation) => void) {
            const acc = createAccumulator();
            const stopReason = await session.prompt(text, (u) =>
              applyUpdate(acc, (u ?? {}) as Parameters<typeof applyUpdate>[1], { onDelta, onToolCall }),
            );
            return { ...acc, stopReason };
          },
          cancel: () => session.cancel(),
          dispose: () => session.dispose(),
        };
      },
    };
    return { ctx, close: raw.close };
  };
}

// Default chat connect fn: resolve against the auto-detected runtime; if the adapter
// can't be resolved (shouldn't happen — the picker only offers available agents), fall
// back to the bare descriptor so connectAcpAdapter surfaces a clear spawn error.
export const chatConnectFn: ChatConnectFn = makeChatConnectFn(
  (d) => resolveLaunch(d, adapterRuntimeCtx()) ?? d,
);

// ── goldmine MCP server descriptor (server-derived, never from request) ───────
// Absolute path to the compiled goldmine MCP stdio server, resolved relative to
// this compiled file (dist/goldmine/chatRoutes.js → dist/goldmine/mcpServer.js).
// process.execPath is the Node binary; the path is constructed server-side only.
const here = dirname(fileURLToPath(import.meta.url));
const goldmineMcpBin = join(here, "mcpServer.js");

export function goldmineMcpServers(): McpServerStdio[] {
  return [stdioMcpServer("agentgem-goldmine", process.execPath, [goldmineMcpBin])];
}
