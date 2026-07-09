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
import type { ChatManager, ChatConnectFn, ChatCtx, ChatSessionHandle, ToolInvocation } from "@agentgem/run";
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
  body: { agentId?: unknown; miniapp?: unknown; project?: unknown },
  deps: Pick<ChatRouteDeps, "buildBrief" | "goldmineMcp" | "resolveStudio" | "resolveProjectCwd" | "neutralCwd">,
): Promise<{ agentId: string; brief: string; mcpServers: McpServerStdio[]; cwd?: string; permission?: "allow" | "deny" }> {
  const agentId = String(body?.agentId ?? "");
  if (!agentId) throw new Error("agentId required");
  const miniapp = body?.miniapp ? String(body.miniapp) : "";
  const project = body?.project ? String(body.project) : "";
  if (miniapp && project) throw new Error("miniapp and project are mutually exclusive");
  if (miniapp) {
    if (!deps.resolveStudio) throw new Error("studio not available");
    const s = deps.resolveStudio(miniapp); // resolver validates the name; throws on a bad one
    // "allow" so the studio agent can Edit/Write the miniapp; its cwd is jailed to the miniapp dir.
    return { agentId, brief: s.brief, mcpServers: deps.goldmineMcp(), cwd: s.cwd, permission: "allow" };
  }
  if (project) {
    if (!deps.resolveProjectCwd) throw new Error("project launch not available");
    const cwd = deps.resolveProjectCwd(project); // validates against the allow-list
    if (!cwd) throw new Error("unknown project");
    // Neutral brief + normal permission: a project chat is not a studio session and must not
    // silently gain write access to the real repo.
    return { agentId, brief: await deps.buildBrief(), mcpServers: deps.goldmineMcp(), cwd };
  }
  return { agentId, brief: await deps.buildBrief(), mcpServers: deps.goldmineMcp(), cwd: deps.neutralCwd };
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
      res.status(500).json({ error: err.message });
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
      res.json({ chatId });
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

  // GET /api/chat/stream?chatId=...&message=... — SSE stream of ChatEvents
  // Only message text flows from the query string; chatId is an opaque server-issued id.
  app.get("/api/chat/stream", guard, async (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("Connection", "keep-alive");

    const chatId = String(req.query.chatId ?? "");
    const message = String(req.query.message ?? "");

    // AG-UI protocol opt-in: same underlying ChatEvent stream, translated via the
    // aguiStream mapper into standard AG-UI events. The event type lives inside the
    // JSON payload (no `event:` line) per the AG-UI SSE convention. Additive — the
    // native path below is untouched for any other (or absent) `protocol` value.
    if (String(req.query.protocol ?? "") === "ag-ui") {
      const mapper = createAguiMapper({ threadId: chatId, runId: randomUUID(), genId: () => randomUUID() });
      const emit = (e: AguiEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
      for (const e of mapper.start()) emit(e);
      try {
        for await (const ev of deps.manager.sendMessage(chatId, message)) {
          for (const e of mapper.onChat(ev)) emit(e);
        }
      } catch (e) {
        for (const ev of mapper.error((e as Error).message)) emit(ev);
      }
      res.end();
      return;
    }

    const send = (event: string, data: unknown) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    let failed = false;
    try {
      for await (const ev of deps.manager.sendMessage(chatId, message)) {
        if (ev.type === "failed") failed = true;
        send(ev.type, ev);
      }
    } catch (e) {
      failed = true;
      send("failed", { error: (e as Error).message });
    }

    // Turn done. For a studio session that did NOT fail, checkpoint the miniapp (durability + opportunistic
    // gem). The client already received `done`; this runs after and never affects the turn — a checkpoint
    // failure is logged and swallowed.
    const miniapp = chatMiniapps.get(chatId);
    if (!failed && miniapp && deps.checkpointMiniapp) {
      try { await deps.checkpointMiniapp(miniapp); }
      catch (e) { console.error(`checkpoint failed for miniapp ${miniapp}:`, (e as Error).message); }
    }

    res.end();
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

  // DELETE /api/chat/:chatId — close + evict the session
  app.delete("/api/chat/:chatId", guard, (req, res) => {
    deps.manager.closeChat(req.params.chatId);
    chatMiniapps.delete(req.params.chatId);
    res.json({ ok: true });
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
          setMode: (m: string) => session.setMode(m),
          async prompt(text: string, onDelta?: (c: string) => void, onToolCall?: (t: ToolInvocation) => void) {
            const acc = createAccumulator();
            await session.prompt(text, (u) =>
              applyUpdate(acc, (u ?? {}) as Parameters<typeof applyUpdate>[1], { onDelta, onToolCall }),
            );
            return acc;
          },
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
