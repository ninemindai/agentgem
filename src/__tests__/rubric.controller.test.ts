// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/__tests__/rubric.controller.test.ts
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import supertest from "supertest";
import { RestApplication } from "@agentback/rest";
import { RubricController, setRubricComputeForTests, setReportRenderForTests } from "@agentgem/app/rubric.controller";
import { RubricEvent, RubricReportEvent } from "@agentgem/app/rubric.stream.schema";
import { ReportRegistry, REPORT_REGISTRY } from "@agentgem/app/report/registry";
import { isForegroundBusy } from "@agentgem/app/warm/orchestrator";
import type { RubricResult } from "@agentgem/app/rubricCore";

let app: RestApplication;
let client: ReturnType<typeof supertest>;
let homeDir: string;
let prevHome: string | undefined;

// A minimal valid rubric draft the editor might POST.
const draft = {
  id: "my-rubric",
  title: "My Rubric",
  target: "process",
  factors: [{ factor: "verification-discipline" }],
};

beforeAll(async () => {
  // Point AGENTGEM_HOME at a temp dir so save/delete write there, never ~/.agentgem.
  homeDir = mkdtempSync(join(tmpdir(), "rubric-home-"));
  prevHome = process.env.AGENTGEM_HOME;
  process.env.AGENTGEM_HOME = homeDir;

  app = new RestApplication({});
  app.configure("servers.RestServer").to({ port: 0, host: "127.0.0.1" });
  app.restController(RubricController);
  await app.start();
  const server = await app.restServer;
  client = supertest(server.url);
});

afterAll(async () => {
  await app.stop();
  if (prevHome === undefined) delete process.env.AGENTGEM_HOME;
  else process.env.AGENTGEM_HOME = prevHome;
  rmSync(homeDir, { recursive: true, force: true });
});

describe("RubricController", () => {
  it("GET /api/rubrics lists built-ins flagged builtin:true", async () => {
    const res = await client.get("/api/rubrics");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.rubrics)).toBe(true);
    expect(res.body.rubrics.length).toBeGreaterThan(0);
    // Every catalog entry carries the builtin flag the picker gates edit/delete on.
    expect(res.body.rubrics.every((r: { builtin: unknown }) => typeof r.builtin === "boolean")).toBe(true);
    expect(res.body.rubrics.some((r: { builtin: boolean }) => r.builtin)).toBe(true);
  });

  it("POST /api/rubrics/validate answers 200 (not 422) with valid:false for a bad draft", async () => {
    const res = await client.post("/api/rubrics/validate").send({ nonsense: true });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(typeof res.body.error).toBe("string");
  });

  it("POST /api/rubrics/validate accepts a well-formed draft", async () => {
    const res = await client.post("/api/rubrics/validate").send(draft);
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.rubric.id).toBe("my-rubric");
    expect(res.body.saved).toBeUndefined(); // validate never writes
  });

  it("POST /api/rubrics saves, GET reflects it, and delete round-trips", async () => {
    const save = await client.post("/api/rubrics").send(draft);
    expect(save.status).toBe(200);
    expect(save.body).toMatchObject({ valid: true, saved: true });

    const listed = await client.get("/api/rubrics");
    expect(listed.body.rubrics.some((r: { id: string; builtin: boolean }) => r.id === "my-rubric" && !r.builtin)).toBe(true);

    const del = await client.post("/api/rubrics/delete").send({ id: "my-rubric" });
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ deleted: true });
  });

  it("POST /api/rubrics/delete refuses a built-in", async () => {
    const list = await client.get("/api/rubrics");
    const builtin = list.body.rubrics.find((r: { builtin: boolean }) => r.builtin);
    const res = await client.post("/api/rubrics/delete").send({ id: builtin.id });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(false);
    expect(res.body.error).toMatch(/built-in/i);
  });

  it("POST /api/rubrics/delete 422s when id is missing (schema-gated)", async () => {
    const res = await client.post("/api/rubrics/delete").send({});
    expect(res.status).toBe(422);
  });
});

// GET /api/rubric/stream — driven directly (the generator), computeRubric swapped;
// resolveRubric stays real (the built-in "hygiene" rubric resolves in-memory).
afterEach(() => setRubricComputeForTests(null));

function fakeCompute(deltas: string[]) {
  return (async (_rubric: unknown, _scope: unknown, opts?: { onDelta?: (c: string) => void }) => {
    for (const d of deltas) opts?.onDelta?.(d);
    return { payload: { rubricId: "hygiene", target: "process", scope: "project", factors: [] }, cached: false, updatedAt: 0 } as unknown as RubricResult;
  }) as unknown as Parameters<typeof setRubricComputeForTests>[0];
}

async function drain(gen: AsyncGenerator<unknown>) {
  const out: unknown[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("RubricController.stream (streamOf route)", () => {
  it("opens with start, streams deltas, then done — each validated", async () => {
    setRubricComputeForTests(fakeCompute(["evaluating factor…"]));

    const events = await drain(new RubricController().stream({ query: { rubric: "hygiene", scope: "project", root: "/x" } }));

    expect(events.map((e) => (e as { type: string }).type)).toEqual(["start", "delta", "done"]);
    for (const e of events) expect(RubricEvent.safeParse(e).success).toBe(true);
    expect(events[0]).toMatchObject({ type: "start", rubric: "hygiene", scope: "project" });
    expect(events[2]).toMatchObject({ type: "done", cached: false, updatedAt: 0 });
  });

  it("yields a failed event for an unknown rubric (not a 422)", async () => {
    const events = await drain(new RubricController().stream({ query: { rubric: "does-not-exist", scope: "all" } }));
    expect(events).toEqual([{ type: "failed", message: "unknown rubric: does-not-exist" }]);
  });

  it("yields a failed event when project scope is missing ?root=", async () => {
    setRubricComputeForTests(fakeCompute([]));
    const events = await drain(new RubricController().stream({ query: { rubric: "hygiene", scope: "project" } }));
    expect(events).toEqual([{ type: "failed", message: "project scope requires ?root=" }]);
  });

  it("yields a failed event when session scope is missing ?sessionId=", async () => {
    setRubricComputeForTests(fakeCompute([]));
    const events = await drain(new RubricController().stream({ query: { rubric: "hygiene", scope: "session" } }));
    expect(events).toEqual([{ type: "failed", message: "session scope requires ?sessionId=" }]);
  });

  it("derives the session root from the transcript when ?root= is omitted", async () => {
    // A claude-dir fixture holding one session transcript whose first record carries the cwd.
    const claudeFixture = mkdtempSync(join(tmpdir(), "rubric-claude-"));
    try {
      mkdirSync(join(claudeFixture, "projects", "p1"), { recursive: true });
      writeFileSync(join(claudeFixture, "projects", "p1", "sess-derive.jsonl"), JSON.stringify({ cwd: "/my/project" }) + "\n");
      let seen: unknown = null;
      setRubricComputeForTests((async (_rubric: unknown, scope: unknown) => {
        seen = scope;
        return { payload: { rubricId: "hygiene", target: "process", scope: "session", factors: [] }, cached: false, updatedAt: 0 } as unknown as RubricResult;
      }) as unknown as Parameters<typeof setRubricComputeForTests>[0]);

      const events = await drain(new RubricController().stream({
        query: { rubric: "hygiene", scope: "session", sessionId: "sess-derive", dir: claudeFixture },
      }));

      expect(events.map((e) => (e as { type: string }).type)).toEqual(["start", "done"]);
      expect(seen).toMatchObject({ kind: "session", root: "/my/project", sessionId: "sess-derive" });
    } finally {
      rmSync(claudeFixture, { recursive: true, force: true });
    }
  });

  it("yields a failed event when the rootless session can't be resolved", async () => {
    const claudeFixture = mkdtempSync(join(tmpdir(), "rubric-claude-"));
    try {
      setRubricComputeForTests(fakeCompute([]));
      const events = await drain(new RubricController().stream({
        query: { rubric: "hygiene", scope: "session", sessionId: "no-such-session", dir: claudeFixture },
      }));
      expect(events).toEqual([{ type: "failed", message: "session not found: no-such-session" }]);
    } finally {
      rmSync(claudeFixture, { recursive: true, force: true });
    }
  });

  it("records the run under kind 'rubric' in an injected ReportRegistry", async () => {
    const reg = new ReportRegistry();
    setRubricComputeForTests(fakeCompute([]));

    await drain(new RubricController(reg).stream({ query: { rubric: "hygiene", scope: "project", root: "/x" } }));

    expect(reg.list().find((r) => r.kind === "rubric" && r.paramsKey === "hygiene:project:/x:")).toMatchObject({ status: "done" });
  });

  it("resolves the injected ReportRegistry bound in the app context", async () => {
    const app2 = new RestApplication({});
    app2.restController(RubricController);
    const reg = new ReportRegistry();
    app2.bind(REPORT_REGISTRY).to(reg);

    const ctrl = await app2.get<RubricController>("controllers.RubricController");
    setRubricComputeForTests(fakeCompute([]));
    await drain(ctrl.stream({ query: { rubric: "hygiene", scope: "all" } }));

    expect(reg.list().find((r) => r.kind === "rubric")).toMatchObject({ status: "done" });
  });

  it("report route: renders the cached evaluation into html (start → delta → done)", async () => {
    setRubricComputeForTests(fakeCompute([]));
    setReportRenderForTests(async (input) => {
      input.onDelta?.("rendering…");
      return { html: "<html>R</html>", ok: true };
    });
    try {
      const events = await drain(new RubricController().report({ query: { rubric: "hygiene", scope: "project", root: "/x" } }));
      expect(events.map((e) => (e as { type: string }).type)).toEqual(["start", "delta", "done"]);
      for (const e of events) expect(RubricReportEvent.safeParse(e).success).toBe(true);
      expect(events[0]).toMatchObject({ type: "start", rubric: "hygiene", scope: "project" });
      expect(events[2]).toMatchObject({ type: "done", html: "<html>R</html>", truncated: false });
    } finally {
      setReportRenderForTests(null);
    }
  });

  it("report route: hands the compute payload to the renderer as FACTS", async () => {
    setRubricComputeForTests(fakeCompute([]));
    let facts: unknown = null;
    setReportRenderForTests(async (input) => { facts = input.facts; return { html: "<p>r</p>", ok: true }; });
    try {
      await drain(new RubricController().report({ query: { rubric: "hygiene", scope: "all" } }));
      expect(facts).toMatchObject({ rubricId: "hygiene" });
    } finally {
      setReportRenderForTests(null);
    }
  });

  it("report route: a degraded renderer (agent offline) becomes a failed event", async () => {
    setRubricComputeForTests(fakeCompute([]));
    setReportRenderForTests(async () => ({ html: "", ok: false }));
    try {
      const events = await drain(new RubricController().report({ query: { rubric: "hygiene", scope: "all" } }));
      expect(events.map((e) => (e as { type: string }).type)).toEqual(["start", "failed"]);
      expect(events[1]).toMatchObject({ type: "failed", message: expect.stringContaining("report rendering failed") });
    } finally {
      setReportRenderForTests(null);
    }
  });

  it("report route: unknown rubric is a failed event", async () => {
    const events = await drain(new RubricController().report({ query: { rubric: "nope" } }));
    expect(events).toEqual([{ type: "failed", message: "unknown rubric: nope" }]);
  });

  it("holds the foreground gate until compute settles, even after client disconnect", async () => {
    expect(isForegroundBusy()).toBe(false);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    setRubricComputeForTests((async () => { await gate; return { payload: {}, cached: false, updatedAt: 0 } as unknown as RubricResult; }) as unknown as Parameters<typeof setRubricComputeForTests>[0]);

    const gen = new RubricController().stream({ query: { rubric: "hygiene", scope: "all" } });
    await gen.next(); // start event -> producer running, foreground begun
    expect(isForegroundBusy()).toBe(true);
    await gen.return(undefined);
    expect(isForegroundBusy()).toBe(true); // held — compute runs on in the background
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(isForegroundBusy()).toBe(false);
  });
});
