// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/goldmine/__tests__/chatRoutes.test.ts
//
// Integration tests for the goldmine chat REST + SSE endpoints.
// Uses a fake connectFn injected into a real ChatManager so no ACP process is
// spawned. supertest drives a minimal RestApplication's expressApp directly
// without binding a port — no express import needed; RestApplication is a devDep.
import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import { RestApplication } from "@agentback/rest";
import { ChatManager } from "@agentgem/run";
import type { ChatConnectFn } from "@agentgem/run";
import { registerChatRoutes } from "../chatRoutes.js";

// ── Fake connect fn ──────────────────────────────────────────────────────────
function makeFakeConnectFn(opts: { fail?: boolean } = {}): ChatConnectFn {
  return async () => ({
    ctx: {
      open: async () => ({
        setMode: async () => {},
        prompt: async (_text: string, onDelta?: (c: string) => void) => {
          if (opts.fail) throw new Error("boom");
          onDelta?.("hi there");
          return { text: "hi there", toolCalls: [] };
        },
        dispose: () => {},
      }),
    },
    close: () => {},
  });
}

// ── App fixture ───────────────────────────────────────────────────────────────
// Minimal RestApplication: just the RestServer (with json body parser) and our
// chat routes. No controllers, no originGuard, no DB. supertest uses expressApp
// directly without binding a port so tests are fast and port-collision-free.
const stoppable: RestApplication[] = [];

async function buildTestApp(opts: { fail?: boolean; checkpoints?: string[] } = {}) {
  const restApp = new RestApplication({});
  restApp.configure("servers.RestServer").to({ port: 0, host: "127.0.0.1", bodyParser: { json: {} } });
  await restApp.start();
  stoppable.push(restApp);

  const server = await restApp.restServer;
  const fakeManager = new ChatManager({ connectFn: makeFakeConnectFn({ fail: opts.fail }) });
  registerChatRoutes(server.expressApp as never, {
    manager: fakeManager,
    buildBrief: async () => "BRIEF",
    goldmineMcp: () => [],
    listAgents: () => [{ id: "claude-code", name: "Claude Code", available: true, installable: false, source: "path" }],
    resolveStudio: () => ({ cwd: "/tmp/miniapp", brief: "STUDIO" }),
    checkpointMiniapp: async (name: string) => { opts.checkpoints?.push(name); },
  });
  return server.expressApp;
}

afterEach(async () => {
  for (const a of stoppable.splice(0)) {
    try { await a.stop(); } catch { /* ignore */ }
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────
describe("chat routes", () => {
  it("GET /api/agents returns availability", async () => {
    const app = await buildTestApp();
    const res = await request(app).get("/api/agents");
    expect(res.status).toBe(200);
    expect(res.body.agents[0]).toMatchObject({ id: "claude-code", available: true });
  });

  it("POST /api/chat without agentId returns 400", async () => {
    const app = await buildTestApp();
    const res = await request(app)
      .post("/api/chat")
      .set("Content-Type", "application/json")
      .send("{}");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/agentId/);
  });

  it("POST /api/chat then SSE stream yields delta + done", async () => {
    const app = await buildTestApp();

    const created = await request(app)
      .post("/api/chat")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ agentId: "claude-code" }));
    expect(created.status).toBe(200);
    const chatId = created.body.chatId;
    expect(chatId).toBeTruthy();

    const res = await request(app)
      .get(`/api/chat/stream?chatId=${chatId}&message=hi`);
    expect(res.text).toContain("event: delta");   // native frame shape unchanged
    expect(res.text).toContain("hi there");        // delta frame
    expect(res.text).toContain("event: done");
  });

  it("GET .../stream?protocol=ag-ui emits AG-UI SSE frames instead of native ones", async () => {
    const app = await buildTestApp();

    const created = await request(app)
      .post("/api/chat")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ agentId: "claude-code" }));
    const chatId = created.body.chatId;

    const res = await request(app)
      .get(`/api/chat/stream?chatId=${chatId}&message=hi&protocol=ag-ui`);

    // AG-UI SSE frames are `data: {json}\n\n` — no `event:` line, type is inside the JSON.
    expect(res.text).not.toContain("event: delta");
    expect(res.text).not.toContain("event: done");
    const frames = res.text
      .split("\n\n")
      .filter((s) => s.startsWith("data: "))
      .map((s) => JSON.parse(s.slice("data: ".length)));

    expect(frames[0].type).toBe("RUN_STARTED");
    expect(frames.some((f) => f.type === "TEXT_MESSAGE_CONTENT")).toBe(true);
    expect(frames[frames.length - 1].type).toBe("RUN_FINISHED");
  });

  it("DELETE /api/chat/:chatId returns ok:true", async () => {
    const app = await buildTestApp();

    const created = await request(app)
      .post("/api/chat")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ agentId: "claude-code" }));
    const chatId = created.body.chatId;

    const res = await request(app).delete(`/api/chat/${chatId}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("checkpoints after a successful studio (miniapp) turn", async () => {
    const checkpoints: string[] = [];
    const app = await buildTestApp({ checkpoints });
    const created = await request(app).post("/api/chat")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ agentId: "claude-code", miniapp: "space-run" }));
    const chatId = created.body.chatId;
    await request(app).get(`/api/chat/stream?chatId=${chatId}&message=hi`);
    expect(checkpoints).toEqual(["space-run"]);
  });

  it("does NOT checkpoint a neutral (non-miniapp) chat", async () => {
    const checkpoints: string[] = [];
    const app = await buildTestApp({ checkpoints });
    const created = await request(app).post("/api/chat")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ agentId: "claude-code" }));
    await request(app).get(`/api/chat/stream?chatId=${created.body.chatId}&message=hi`);
    expect(checkpoints).toEqual([]);
  });

  it("does NOT checkpoint when the turn fails", async () => {
    const checkpoints: string[] = [];
    const app = await buildTestApp({ fail: true, checkpoints });
    const created = await request(app).post("/api/chat")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ agentId: "claude-code", miniapp: "space-run" }));
    const res = await request(app).get(`/api/chat/stream?chatId=${created.body.chatId}&message=hi`);
    expect(res.text).toContain("event: failed");
    expect(checkpoints).toEqual([]);
  });
});
