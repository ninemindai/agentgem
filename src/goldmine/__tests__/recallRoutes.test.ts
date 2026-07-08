// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/goldmine/__tests__/recallRoutes.test.ts
//
// Unit tests for the Recall REST + SSE route module. `streamFunnel` is tested
// directly against a fake Res + a hand-rolled FunnelEvent generator (no HTTP
// server needed). The remaining routes are tested by registering against a
// fake duck-typed App that just captures handlers by path, then invoking each
// handler directly with a fake Req/Res — mirrors the module's own duck typing,
// no supertest/RestApplication needed.
import { describe, it, expect } from "vitest";
import type { FunnelEvent, MomentHit, SessionRef } from "@agentgem/recall";
import { streamFunnel, registerRecallRoutes, type RecallRouteDeps } from "../recallRoutes.js";

// ── Fakes ──────────────────────────────────────────────────────────────────
function fakeRes() {
  const writes: string[] = [];
  const statusCodes: number[] = [];
  const jsonBodies: unknown[] = [];
  let ended = 0;
  const res: {
    status(code: number): typeof res;
    json(body: unknown): void;
    setHeader(name: string, value: string): void;
    write(chunk: string): void;
    end(): void;
  } = {
    status(code: number) { statusCodes.push(code); return res; },
    json(body: unknown) { jsonBodies.push(body); },
    setHeader() {},
    write(chunk: string) { writes.push(chunk); },
    end() { ended++; },
  };
  return { res, writes, statusCodes, jsonBodies, endedCount: () => ended };
}

async function* fakeGen(): AsyncGenerator<FunnelEvent> {
  yield { type: "session_started", sessionId: "s1" };
  yield { type: "session_done", sessionId: "s1", answered: true };
  yield { type: "done", answers: [], synthesis: "x" };
}

type Handler = (req: never, res: never) => unknown;
function fakeApp() {
  const routes: Record<string, Handler> = {};
  const app = {
    get(path: string, _guard: unknown, handler: Handler) { routes[`GET ${path}`] = handler; },
    post(path: string, _guard: unknown, handler: Handler) { routes[`POST ${path}`] = handler; },
    delete(path: string, _guard: unknown, handler: Handler) { routes[`DELETE ${path}`] = handler; },
  };
  return { app, routes };
}

function fakeDeps(overrides: Partial<RecallRouteDeps> = {}): RecallRouteDeps {
  return {
    readIndex: { search: () => [] as MomentHit[] } as never,
    listSessions: async () => [] as SessionRef[],
    funnelDeps: { askOne: async () => ({ answered: true, answer: "" }), synthesize: async function* () {} },
    indexStatus: () => ({ ready: true, indexed: 0, total: 0 }),
    ...overrides,
  };
}

// ── streamFunnel ─────────────────────────────────────────────────────────────
describe("streamFunnel", () => {
  it("writes each event as an SSE frame in order, then ends exactly once", async () => {
    const { res, writes, endedCount } = fakeRes();
    await streamFunnel(res as never, fakeGen());
    expect(writes).toEqual([
      `event: session_started\ndata: ${JSON.stringify({ type: "session_started", sessionId: "s1" })}\n\n`,
      `event: session_done\ndata: ${JSON.stringify({ type: "session_done", sessionId: "s1", answered: true })}\n\n`,
      `event: done\ndata: ${JSON.stringify({ type: "done", answers: [], synthesis: "x" })}\n\n`,
    ]);
    expect(endedCount()).toBe(1);
  });
});

// ── GET /api/recall/search ──────────────────────────────────────────────────
describe("GET /api/recall/search", () => {
  it("returns {moments:[]} for an empty/whitespace q without touching the index", () => {
    const { app, routes } = fakeApp();
    let searched = false;
    const deps = fakeDeps({ readIndex: { search: () => { searched = true; return []; } } as never });
    registerRecallRoutes(app as never, deps);
    const { res, jsonBodies } = fakeRes();
    routes["GET /api/recall/search"]({ query: { q: "  " }, params: {} } as never, res as never);
    expect(jsonBodies).toEqual([{ moments: [] }]);
    expect(searched).toBe(false);
  });

  it("parses filters + limit and delegates to readIndex.search", () => {
    const { app, routes } = fakeApp();
    const calls: unknown[] = [];
    const hit: MomentHit = { sessionId: "s1", agent: "claude", turn: 1, project: "p", branch: null, startMs: 1, snippet: "x", score: 0.1, turnsMatched: 1 };
    const deps = fakeDeps({
      readIndex: { search: (q: string, f: unknown, limit: number) => { calls.push([q, f, limit]); return [hit]; } } as never,
    });
    registerRecallRoutes(app as never, deps);
    const { res, jsonBodies } = fakeRes();
    routes["GET /api/recall/search"](
      { query: { q: "migration", project: "p", agent: "claude", since: "100", limit: "5" }, params: {} } as never,
      res as never,
    );
    expect(calls).toEqual([["migration", { project: "p", agent: "claude", since: 100 }, 5]]);
    expect(jsonBodies).toEqual([{ moments: [hit] }]);
  });

  it("defaults limit to 12 when absent", () => {
    const { app, routes } = fakeApp();
    let seenLimit = -1;
    const deps = fakeDeps({ readIndex: { search: (_q: string, _f: unknown, limit: number) => { seenLimit = limit; return []; } } as never });
    registerRecallRoutes(app as never, deps);
    const { res } = fakeRes();
    routes["GET /api/recall/search"]({ query: { q: "x" }, params: {} } as never, res as never);
    expect(seenLimit).toBe(12);
  });
});

// ── GET /api/recall/status ──────────────────────────────────────────────────
describe("GET /api/recall/status", () => {
  it("returns deps.indexStatus()", () => {
    const { app, routes } = fakeApp();
    const status = { ready: true, indexed: 3, total: 5 };
    registerRecallRoutes(app as never, fakeDeps({ indexStatus: () => status }));
    const { res, jsonBodies } = fakeRes();
    routes["GET /api/recall/status"]({ query: {}, params: {} } as never, res as never);
    expect(jsonBodies).toEqual([status]);
  });
});

// ── POST /api/recall/run ────────────────────────────────────────────────────
describe("POST /api/recall/run", () => {
  it("400s on missing/invalid fields", async () => {
    const { app, routes } = fakeApp();
    registerRecallRoutes(app as never, fakeDeps());
    const { res, statusCodes, jsonBodies } = fakeRes();
    await routes["POST /api/recall/run"]({ body: { prompt: "x", mode: "chat" }, query: {}, params: {} } as never, res as never);
    expect(statusCodes).toEqual([400]);
    expect((jsonBodies[0] as { error: string }).error).toBeTruthy();
  });

  it("400s on an unknown mode", async () => {
    const { app, routes } = fakeApp();
    registerRecallRoutes(app as never, fakeDeps());
    const { res, statusCodes } = fakeRes();
    await routes["POST /api/recall/run"](
      { body: { sessionIds: [{ sessionId: "s1", agent: "claude" }], prompt: "x", mode: "bogus" }, query: {}, params: {} } as never,
      res as never,
    );
    expect(statusCodes).toEqual([400]);
  });

  it("mints a jobId on valid input", async () => {
    const { app, routes } = fakeApp();
    registerRecallRoutes(app as never, fakeDeps());
    const { res, jsonBodies } = fakeRes();
    await routes["POST /api/recall/run"](
      { body: { sessionIds: [{ sessionId: "s1", agent: "claude" }], prompt: "summarize", mode: "chat" }, query: {}, params: {} } as never,
      res as never,
    );
    expect((jsonBodies[0] as { jobId: string }).jobId).toMatch(/^recall_\d+$/);
  });
});

// ── GET /api/recall/stream + DELETE /api/recall/:jobId ─────────────────────
describe("GET /api/recall/stream", () => {
  it("404s on an unknown jobId", async () => {
    const { app, routes } = fakeApp();
    registerRecallRoutes(app as never, fakeDeps());
    const { res, statusCodes } = fakeRes();
    await routes["GET /api/recall/stream"]({ query: { jobId: "nope" }, params: {} } as never, res as never);
    expect(statusCodes).toEqual([404]);
  });

  it("streams the funnel for a job minted by /run, then evicts it", async () => {
    const { app, routes } = fakeApp();
    const funnelDeps = {
      askOne: async () => ({ answered: true, answer: "found it" }),
      synthesize: async function* () { yield "synth"; },
    };
    registerRecallRoutes(app as never, fakeDeps({ funnelDeps }));
    const runRes = fakeRes();
    await routes["POST /api/recall/run"](
      { body: { sessionIds: [{ sessionId: "s1", agent: "claude" }], prompt: "summarize", mode: "chat" }, query: {}, params: {} } as never,
      runRes.res as never,
    );
    const jobId = (runRes.jsonBodies[0] as { jobId: string }).jobId;

    const streamRes = fakeRes();
    await routes["GET /api/recall/stream"]({ query: { jobId }, params: {} } as never, streamRes.res as never);
    expect(streamRes.writes.some((w) => w.startsWith("event: session_started"))).toBe(true);
    expect(streamRes.writes.some((w) => w.startsWith("event: done"))).toBe(true);
    expect(streamRes.endedCount()).toBe(1);

    // Job was evicted: a second stream attempt 404s.
    const secondRes = fakeRes();
    await routes["GET /api/recall/stream"]({ query: { jobId }, params: {} } as never, secondRes.res as never);
    expect(secondRes.statusCodes).toEqual([404]);
  });

  it("aborts the job's controller on req 'close'", async () => {
    const { app, routes } = fakeApp();
    let abortedBeforeConsume = false;
    const funnelDeps = {
      askOne: async () => ({ answered: true, answer: "" }),
      synthesize: async function* () {},
    };
    registerRecallRoutes(app as never, fakeDeps({ funnelDeps }));
    const runRes = fakeRes();
    await routes["POST /api/recall/run"](
      { body: { sessionIds: [{ sessionId: "s1", agent: "claude" }], prompt: "x", mode: "chat" }, query: {}, params: {} } as never,
      runRes.res as never,
    );
    const jobId = (runRes.jsonBodies[0] as { jobId: string }).jobId;

    let closeCb: (() => void) | undefined;
    const req = { query: { jobId }, params: {}, on: (event: string, cb: () => void) => { if (event === "close") closeCb = cb; } };
    const streamRes = fakeRes();
    const p = routes["GET /api/recall/stream"](req as never, streamRes.res as never);
    closeCb?.();
    abortedBeforeConsume = true;
    await p;
    expect(abortedBeforeConsume).toBe(true);
  });
});

describe("DELETE /api/recall/:jobId", () => {
  it("404s on an unknown jobId", () => {
    const { app, routes } = fakeApp();
    registerRecallRoutes(app as never, fakeDeps());
    const { res, statusCodes } = fakeRes();
    routes["DELETE /api/recall/:jobId"]({ query: {}, params: { jobId: "nope" } } as never, res as never);
    expect(statusCodes).toEqual([404]);
  });

  it("aborts + evicts a known job", async () => {
    const { app, routes } = fakeApp();
    registerRecallRoutes(app as never, fakeDeps());
    const runRes = fakeRes();
    await routes["POST /api/recall/run"](
      { body: { sessionIds: [{ sessionId: "s1", agent: "claude" }], prompt: "x", mode: "chat" }, query: {}, params: {} } as never,
      runRes.res as never,
    );
    const jobId = (runRes.jsonBodies[0] as { jobId: string }).jobId;

    const delRes = fakeRes();
    routes["DELETE /api/recall/:jobId"]({ query: {}, params: { jobId } } as never, delRes.res as never);
    expect(delRes.jsonBodies).toEqual([{ ok: true }]);

    // Second delete 404s: it's gone.
    const delRes2 = fakeRes();
    routes["DELETE /api/recall/:jobId"]({ query: {}, params: { jobId } } as never, delRes2.res as never);
    expect(delRes2.statusCodes).toEqual([404]);
  });
});
