// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/app/src/goldmine/__tests__/chatStreamDisconnect.test.ts
//
// Eng review (PR #535): a disconnected SSE client's GET /api/chat/stream attach loop must
// release at the next wake instead of consuming the rest of the turn — the turn's own drain
// lives in startTurn and is unaffected (R1, chatRoutes.test.ts). Mirrors the hand-rolled
// duck-typed app/req/res harness from that file's "[R1] chat stream background completion"
// suite: a real HTTP server (supertest) can't make res.write() observe a torn-down pipe the
// way `req.on("close")` does, so both suites bypass it for the same reason.
import { describe, expect, it } from "vitest";
import type { ChatManager, ChatEvent } from "@agentgem/run";
import { registerChatRoutes } from "../chatRoutes.js";

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const sse = (ev: ChatEvent) => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;

// Hand-rolled fake app: captures the raw route handlers so the test can invoke them
// directly with req/res objects it fully controls — same technique as chatRoutes.test.ts's R1 suite.
function fakeApp() {
  const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
  const app = {
    get: (path: string, _guard: unknown, handler: (req: unknown, res: unknown) => unknown) => { routes[`GET ${path}`] = handler; },
    post: (path: string, _guard: unknown, handler: (req: unknown, res: unknown) => unknown) => { routes[`POST ${path}`] = handler; },
    delete: (path: string, _guard: unknown, handler: (req: unknown, res: unknown) => unknown) => { routes[`DELETE ${path}`] = handler; },
  };
  return { app, routes };
}

const jsonRes = (onJson: (b: never) => void) => ({ json: onJson, status() { return this; }, setHeader() {}, write() {}, end() {} });

// A GET /api/chat/stream request whose "close" listener is captured so the test can fire it
// on demand (simulating the browser tearing down the connection), and whose res.write
// records every forwarded SSE frame instead of touching a socket.
function fakeStreamReq(query: Record<string, string>) {
  let closeCb: (() => void) | undefined;
  const req = {
    query, body: {}, params: {},
    on: (event: string, cb: () => void) => { if (event === "close") closeCb = cb; },
  };
  const frames: string[] = [];
  const res = {
    json() {}, status() { return this; }, setHeader() {},
    write: (chunk: string) => { frames.push(chunk); },
    end() {},
  };
  return { req, res, frames, close: () => closeCb?.() };
}

describe("chat stream attach loop releases on client disconnect", () => {
  it("disconnect mid-turn stops the stream from receiving further frames, but the turn itself still completes (R1 intact)", async () => {
    const reachedGate = deferred<void>();
    const openGate = deferred<void>();
    const fakeManager = {
      openChat: async () => "chat_1",
      stateOf: () => ({ alive: true, running: false, sessionId: "s", agent: "claude-code", resumed: false }),
      async *sendMessage(): AsyncGenerator<ChatEvent> {
        yield { type: "phase", phase: "running" };
        yield { type: "delta", text: "a" };
        reachedGate.resolve();
        await openGate.promise; // pause mid-turn so the test can attach + disconnect deterministically
        yield { type: "done", result: { text: "a", toolCalls: [] } };
      },
    };

    const { app, routes } = fakeApp();
    registerChatRoutes(app as never, {
      manager: fakeManager as unknown as ChatManager,
      listAgents: () => [],
      buildBrief: async () => "BRIEF",
      goldmineMcp: () => [],
      neutralCwd: "/neutral",
    });

    let chatId = "";
    await routes["POST /api/chat"]({ body: { agentId: "claude-code" }, query: {}, params: {} }, jsonRes((b) => { chatId = (b as { chatId: string }).chatId; }));
    expect(chatId).toBeTruthy();

    let turnId = "";
    await routes["POST /api/chat/turn"]({ body: { chatId, message: "hi" }, query: {}, params: {} }, jsonRes((b) => { turnId = (b as { turnId: string }).turnId; }));
    expect(turnId).toBeTruthy();

    await reachedGate.promise; // phase + delta("a") are published; the turn is now blocked on the gate

    const stream1 = fakeStreamReq({ chatId, turnId });
    const streamPromise1 = routes["GET /api/chat/stream"](stream1.req, stream1.res);
    // Synchronous replay: readFeed + forward run with no await ahead of them, so both
    // already-published frames land before the handler suspends on the wait/gone race.
    expect(stream1.frames).toEqual([sse({ type: "phase", phase: "running" }), sse({ type: "delta", text: "a" })]);

    stream1.close(); // simulate the browser tearing down the connection
    await streamPromise1; // the attach loop must release here, not hang until `done`
    expect(stream1.frames).toHaveLength(2); // never saw `done` — this stream stopped receiving frames

    openGate.resolve(); // let the turn finish in the background, unaffected by stream1's disconnect
    const stream2 = fakeStreamReq({ chatId, turnId });
    await routes["GET /api/chat/stream"](stream2.req, stream2.res); // replays from 0, waits for done+close
    expect(stream2.frames).toEqual([
      sse({ type: "phase", phase: "running" }),
      sse({ type: "delta", text: "a" }),
      sse({ type: "done", result: { text: "a", toolCalls: [] } }),
    ]);
  });
});

describe("two concurrent attachers", () => {
  it("both replay the identical full frame sequence once the turn finishes", async () => {
    const reachedMid = deferred<void>();
    const midGate = deferred<void>();
    const fakeManager = {
      openChat: async () => "chat_2",
      stateOf: () => ({ alive: true, running: false, sessionId: "s", agent: "claude-code", resumed: false }),
      async *sendMessage(): AsyncGenerator<ChatEvent> {
        yield { type: "phase", phase: "running" };
        yield { type: "delta", text: "a" };
        reachedMid.resolve();
        await midGate.promise; // pause mid-turn so a second stream can attach before it finishes
        yield { type: "delta", text: "b" };
        yield { type: "done", result: { text: "ab", toolCalls: [] } };
      },
    };

    const { app, routes } = fakeApp();
    registerChatRoutes(app as never, {
      manager: fakeManager as unknown as ChatManager,
      listAgents: () => [],
      buildBrief: async () => "BRIEF",
      goldmineMcp: () => [],
      neutralCwd: "/neutral",
    });

    let chatId = "";
    await routes["POST /api/chat"]({ body: { agentId: "claude-code" }, query: {}, params: {} }, jsonRes((b) => { chatId = (b as { chatId: string }).chatId; }));

    let turnId = "";
    await routes["POST /api/chat/turn"]({ body: { chatId, message: "hi" }, query: {}, params: {} }, jsonRes((b) => { turnId = (b as { turnId: string }).turnId; }));

    const streamA = fakeStreamReq({ chatId, turnId });
    const promiseA = routes["GET /api/chat/stream"](streamA.req, streamA.res); // attaches from the very start

    await reachedMid.promise; // phase + delta("a") published; turn paused mid-way

    const streamB = fakeStreamReq({ chatId, turnId });
    const promiseB = routes["GET /api/chat/stream"](streamB.req, streamB.res); // attaches mid-turn

    midGate.resolve(); // let the turn finish (delta "b" + done)
    await Promise.all([promiseA, promiseB]);

    const expected = [
      sse({ type: "phase", phase: "running" }),
      sse({ type: "delta", text: "a" }),
      sse({ type: "delta", text: "b" }),
      sse({ type: "done", result: { text: "ab", toolCalls: [] } }),
    ];
    expect(streamA.frames).toEqual(expected);
    expect(streamB.frames).toEqual(expected);
  });
});
