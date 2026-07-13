// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/__tests__/rubric.controller.test.ts
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import supertest from "supertest";
import { RestApplication } from "@agentback/rest";
import { RubricController, setRubricComputeForTests } from "../rubric.controller.js";
import { RubricEvent } from "../rubric.stream.schema.js";
import { ReportRegistry, REPORT_REGISTRY } from "../report/registry.js";
import { isForegroundBusy } from "../warm/orchestrator.js";
import type { RubricResult } from "../rubricCore.js";

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
