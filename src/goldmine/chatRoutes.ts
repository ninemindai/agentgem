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
import { dirname, join } from "node:path";
import { connectAcpAdapter, stdioMcpServer } from "@agentgem/base";
import type { AgentAvailability, AgentDescriptor, McpServerStdio } from "@agentgem/base";
import { createAccumulator, applyUpdate } from "@agentgem/run";
import type { ChatManager, ChatConnectFn, ChatCtx, ChatSessionHandle, ToolInvocation } from "@agentgem/run";
import { draftGemFromChat } from "./draftGem.js";

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
}

// No-op guard used when originGuard is not provided (e.g. in tests that call
// registerChatRoutes directly on a bare app without the CSRF middleware layer).
const noopGuard: Middleware = (_req, _res, next) => next();

export function registerChatRoutes(app: App, deps: ChatRouteDeps, guard: Middleware = noopGuard): void {
  // GET /api/agents — list which agents are on PATH
  app.get("/api/agents", guard, (_req, res) => {
    res.json({ agents: deps.listAgents() });
  });

  // POST /api/chat — open a new chat session; request-derived value is only agentId
  app.post("/api/chat", guard, async (req, res) => {
    try {
      const agentId = String(req.body?.agentId ?? "");
      if (!agentId) { res.status(400).json({ error: "agentId required" }); return; }
      const brief = await deps.buildBrief();
      // SECURITY: mcpServers is server-derived (goldmineMcp()); cwd is server-derived
      // (injected by the real connect wrapper in createApp). Neither value ever comes
      // from the request body.
      const chatId = await deps.manager.openChat({ agentId, brief, mcpServers: deps.goldmineMcp() });
      res.json({ chatId });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
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
    const send = (event: string, data: unknown) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    try {
      for await (const ev of deps.manager.sendMessage(chatId, message)) {
        send(ev.type, ev);
      }
    } catch (e) {
      send("failed", { error: (e as Error).message });
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
export const chatConnectFn: ChatConnectFn = async (descriptor: AgentDescriptor) => {
  const raw = await connectAcpAdapter(descriptor, { clientName: "agentgem-chat", permission: "deny" });
  const ctx: ChatCtx = {
    async open(cwd: string, opts?: { mcpServers?: unknown[] }): Promise<ChatSessionHandle> {
      const session = await raw.open(cwd, { mcpServers: opts?.mcpServers as never });
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

// ── goldmine MCP server descriptor (server-derived, never from request) ───────
// Absolute path to the compiled goldmine MCP stdio server, resolved relative to
// this compiled file (dist/goldmine/chatRoutes.js → dist/goldmine/mcpServer.js).
// process.execPath is the Node binary; the path is constructed server-side only.
const here = dirname(fileURLToPath(import.meta.url));
const goldmineMcpBin = join(here, "mcpServer.js");

export function goldmineMcpServers(): McpServerStdio[] {
  return [stdioMcpServer("agentgem-goldmine", process.execPath, [goldmineMcpBin])];
}
