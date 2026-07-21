// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/goldmine/__tests__/chatCancel.test.ts
//
// Turn interrupt: ChatManager.cancelChat sends the handle's fire-and-forget cancel (ACP
// session/cancel) and the running turn's own stream finishes with done + stopReason
// "cancelled" — the session survives. Route: POST /api/chat/:id/cancel. Harness mirrors
// chatRoutes.test.ts (fake connectFn into a real ChatManager; supertest on expressApp).
import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import { RestApplication } from "@agentback/rest";
import { ChatManager } from "@agentgem/run";
import type { ChatConnectFn } from "@agentgem/run";
import { registerChatRoutes } from "@agentgem/app/goldmine/chatRoutes";

// A fake whose prompt only resolves after cancel() fires — an agent honoring session/cancel.
function makeCancellableConnectFn(): { connectFn: ChatConnectFn; seen: { cancelled: boolean } } {
  const seen = { cancelled: false };
  const connectFn: ChatConnectFn = async () => ({
    ctx: {
      open: async () => {
        let release: (() => void) | null = null;
        return {
          sessionId: "sess_c",
          setMode: async () => {},
          prompt: async () => {
            await new Promise<void>((r) => { release = r; });
            return { text: "partial", toolCalls: [], stopReason: "cancelled" };
          },
          cancel: () => { seen.cancelled = true; release?.(); },
          dispose: () => {},
        };
      },
    },
    close: () => {},
  });
  return { connectFn, seen };
}

// Minimal cancel-free fake (mirrors chatRoutes.test.ts's makeFakeConnectFn).
const plainConnectFn: ChatConnectFn = async () => ({
  ctx: {
    open: async () => ({
      sessionId: "sess_fake",
      setMode: async () => {},
      prompt: async () => ({ text: "hi", toolCalls: [] }),
      dispose: () => {},
    }),
  },
  close: () => {},
});

const DESCRIPTOR = { id: "claude-code", command: ["/bin/true"] };
const openArgs = { agentId: "claude-code", brief: "", descriptor: DESCRIPTOR as never, cwd: "/tmp" };

describe("cancelChat", () => {
  it("cancels a running turn: handle.cancel fires and done carries stopReason cancelled", async () => {
    const { connectFn, seen } = makeCancellableConnectFn();
    const mgr = new ChatManager({ connectFn });
    const chatId = await mgr.openChat(openArgs);
    const events: unknown[] = [];
    const consuming = (async () => { for await (const e of mgr.sendMessage(chatId, "build it")) events.push(e); })();
    await new Promise((r) => setTimeout(r, 20));          // turn is now running
    expect(mgr.cancelChat(chatId)).toBe(true);
    await consuming;
    expect(seen.cancelled).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done", result: { stopReason: "cancelled" } });
    expect(mgr.stateOf(chatId)).toMatchObject({ alive: true, running: false }); // session survives
  });

  it("is a no-op on an idle chat and an unknown chat", async () => {
    const { connectFn } = makeCancellableConnectFn();
    const mgr = new ChatManager({ connectFn });
    const chatId = await mgr.openChat(openArgs);
    expect(mgr.cancelChat(chatId)).toBe(false);           // idle
    expect(mgr.cancelChat("nope")).toBe(false);           // unknown
  });

  it("returns false when the handle has no cancel support", async () => {
    const mgr = new ChatManager({ connectFn: plainConnectFn });
    const chatId = await mgr.openChat(openArgs);
    const consuming = (async () => { for await (const _ of mgr.sendMessage(chatId, "x")) { /* drain */ } })();
    expect(mgr.cancelChat(chatId)).toBe(false);           // running or not — nothing to send
    await consuming;
  });
});

// ── Route: POST /api/chat/:id/cancel ─────────────────────────────────────────
const stoppable: RestApplication[] = [];
afterEach(async () => { while (stoppable.length) await stoppable.pop()!.stop(); });

async function buildApp(connectFn: ChatConnectFn) {
  const restApp = new RestApplication({});
  restApp.configure("servers.RestServer").to({ port: 0, host: "127.0.0.1", bodyParser: { json: {} } });
  await restApp.start();
  stoppable.push(restApp);
  const server = await restApp.restServer;
  const manager = new ChatManager({ connectFn });
  registerChatRoutes(server.expressApp as never, {
    manager,
    buildBrief: async () => "BRIEF",
    goldmineMcp: () => [],
    listAgents: () => [{ id: "claude-code", name: "Claude Code", available: true, installable: false, source: "path" }],
    resolveStudio: () => ({ cwd: "/tmp/miniapp", brief: "STUDIO" }),
    resolveProjectCwd: () => null,
    neutralCwd: "/neutral",
  });
  return { app: server.expressApp, manager };
}

// Eng review issue 6 (cross-model): the client may auto-fire a queued next turn the instant it
// sees `done`, so the checkpoint must complete BEFORE the done frame is written — otherwise the
// next turn's edits race this turn's durability commit. Raw-handler pattern from chatRoutes.test.ts.
describe("checkpoint-before-done ordering", () => {
  it("writes the done frame only after checkpointMiniapp resolves", async () => {
    const order: string[] = [];
    const fakeManager = {
      openChat: async () => "chat_o",
      stateOf: () => ({ alive: true, running: false, sessionId: "s", agent: "claude-code" }),
      async *sendMessage() {
        yield { type: "phase", phase: "running" };
        yield { type: "delta", text: "a" };
        yield { type: "done", result: { text: "a", toolCalls: [] } };
      },
    };
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const fakeApp = {
      get: (p: string, _g: unknown, h: (req: unknown, res: unknown) => unknown) => { routes[`GET ${p}`] = h; },
      post: (p: string, _g: unknown, h: (req: unknown, res: unknown) => unknown) => { routes[`POST ${p}`] = h; },
      delete: (p: string, _g: unknown, h: (req: unknown, res: unknown) => unknown) => { routes[`DELETE ${p}`] = h; },
    };
    registerChatRoutes(fakeApp as never, {
      manager: fakeManager as never,
      buildBrief: async () => "BRIEF",
      goldmineMcp: () => [],
      listAgents: () => [],
      resolveStudio: () => ({ cwd: "/tmp/miniapp", brief: "STUDIO" }),
      neutralCwd: "/neutral",
      checkpointMiniapp: async () => {
        await new Promise((r) => setTimeout(r, 10));   // a real checkpoint takes time — expose racing
        order.push("checkpoint");
      },
    } as never);

    let chatId = "";
    const postRes = { json: (b: { chatId: string }) => { chatId = b.chatId; }, status() { return this; }, setHeader() {}, write() {}, end() {} };
    await routes["POST /api/chat"]({ body: { agentId: "claude-code", miniapp: "demo" }, query: {}, params: {} }, postRes);
    expect(chatId).toBeTruthy();

    const streamRes = {
      setHeader() {}, flushHeaders() {}, end() {}, status() { return this; }, json() {},
      write: (chunk: string) => { if (chunk.includes("event: done")) order.push("done-frame"); return true; },
    };
    await routes["GET /api/chat/stream"]({ query: { chatId, message: "go" }, params: {}, body: {} }, streamRes);
    expect(order).toEqual(["checkpoint", "done-frame"]);
  });
});

describe("POST /api/chat/:id/cancel", () => {
  it("404s for an unknown chat", async () => {
    const { app } = await buildApp(plainConnectFn);
    await request(app).post("/api/chat/ghost/cancel").expect(404);
  });

  it("replies {cancelled:false} for an idle chat", async () => {
    const { app, manager } = await buildApp(makeCancellableConnectFn().connectFn);
    const chatId = await manager.openChat(openArgs);
    const res = await request(app).post(`/api/chat/${chatId}/cancel`).expect(200);
    expect(res.body).toEqual({ cancelled: false });
  });

  it("replies {cancelled:true} while a turn runs, and the turn ends cancelled", async () => {
    const { connectFn, seen } = makeCancellableConnectFn();
    const { app, manager } = await buildApp(connectFn);
    const chatId = await manager.openChat(openArgs);
    const events: unknown[] = [];
    const consuming = (async () => { for await (const e of manager.sendMessage(chatId, "go")) events.push(e); })();
    await new Promise((r) => setTimeout(r, 20));
    const res = await request(app).post(`/api/chat/${chatId}/cancel`).expect(200);
    expect(res.body).toEqual({ cancelled: true });
    await consuming;
    expect(seen.cancelled).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done", result: { stopReason: "cancelled" } });
  });
});
