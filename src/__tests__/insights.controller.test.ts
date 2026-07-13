// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import {
  InsightsController,
  setInsightsComputeForTests,
} from "../insights.controller.js";
import { RestApplication } from "@agentback/rest";
import { isForegroundBusy } from "../warm/orchestrator.js";
import { InsightsEvent } from "../insights.stream.schema.js";
import { ReportRegistry, REPORT_REGISTRY } from "../report/registry.js";
import type { InsightsResult } from "../insightsCore.js";

afterEach(() => setInsightsComputeForTests(null));

// A minimal computeInsights double: fires the progress callbacks the route maps,
// then resolves with a minimal payload. Cast past the rich InsightsPayload shape
// the route never inspects beyond report/degraded/signalSummary.
function fakeCompute(events: Array<[string, Record<string, unknown>?]>, deltas: string[]) {
  return (async (_root: string, opts: { progress?: { onPhase?: (p: string, e?: Record<string, unknown>) => void; onDelta?: (t: string) => void } }) => {
    for (const [phase, extra] of events) opts.progress?.onPhase?.(phase, extra);
    for (const d of deltas) opts.progress?.onDelta?.(d);
    return {
      payload: { report: { ok: true }, facets: [], findings: [], detectorSummary: [], degraded: false, signalSummary: { sessionsScanned: 2, spanDays: 1, notes: null } },
      cached: false,
      updatedAt: 123,
    } as unknown as InsightsResult;
  }) as unknown as Parameters<typeof setInsightsComputeForTests>[0];
}

async function drain(gen: AsyncGenerator<unknown>) {
  const out: unknown[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("InsightsController.stream (streamOf route)", () => {
  it("maps push-style progress into a validated phase/delta/done union", async () => {
    setInsightsComputeForTests(fakeCompute([["scanning"], ["scanned", { transcripts: 3, sessions: 2 }]], ["narrate…"]));

    const events = await drain(new InsightsController().stream({ query: { root: "/proj" } }));

    expect(events.map((e) => (e as { type: string }).type)).toEqual(["phase", "phase", "delta", "done"]);
    // every emitted item must satisfy the wire schema the framework validates against
    for (const e of events) expect(InsightsEvent.safeParse(e).success).toBe(true);
    expect(events[1]).toMatchObject({ type: "phase", phase: "scanned", transcripts: 3, sessions: 2 });
    expect(events[3]).toMatchObject({ type: "done", degraded: false, scanned: 2, updatedAt: 123 });
  });

  it("records the run lifecycle in an injected ReportRegistry (reattach support)", async () => {
    const reg = new ReportRegistry();
    setInsightsComputeForTests(fakeCompute([["scanned", { sessions: 2 }]], []));

    await drain(new InsightsController(reg).stream({ query: { root: "/proj" } }));

    // finish("done") overwrites phase to "done"; the run is recorded terminal so
    // a returning panel finds it (a cache-hit reattach).
    const run = reg.list().find((r) => r.kind === "insights" && r.paramsKey === "/proj");
    expect(run).toMatchObject({ status: "done", params: { root: "/proj" } });
  });

  it("marks the registry run failed when compute throws", async () => {
    const reg = new ReportRegistry();
    setInsightsComputeForTests((async () => { throw new Error("boom"); }) as unknown as Parameters<typeof setInsightsComputeForTests>[0]);

    await drain(new InsightsController(reg).stream({ query: { root: "/p" } }));

    const run = reg.list().find((r) => r.kind === "insights" && r.paramsKey === "/p");
    expect(run).toMatchObject({ status: "failed", error: "boom" });
  });

  it("holds the foreground gate until compute settles, even after client disconnect", async () => {
    expect(isForegroundBusy()).toBe(false); // prior tests balanced begin/end
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    setInsightsComputeForTests((async (_root: string, opts: { progress?: { onPhase?: (p: string) => void } }) => {
      opts.progress?.onPhase?.("scanning");
      await gate; // compute stays in flight
      return { payload: { report: {}, facets: [], findings: [], detectorSummary: [], degraded: false, signalSummary: { sessionsScanned: 0, spanDays: 0, notes: null } }, cached: false, updatedAt: 0 } as unknown as InsightsResult;
    }) as unknown as Parameters<typeof setInsightsComputeForTests>[0]);

    const gen = new InsightsController().stream({ query: { root: "/dc" } });
    await gen.next();                          // first pull → producer started, foreground begun
    expect(isForegroundBusy()).toBe(true);

    await gen.return(undefined);               // simulate client disconnect (framework iterator.return())
    expect(isForegroundBusy()).toBe(true);     // still held — compute runs on in the background

    release();
    await new Promise((r) => setTimeout(r, 0)); // let the producer's finally run
    expect(isForegroundBusy()).toBe(false);     // released only once compute settled
  });

  it("turns a compute failure into a single failed event (never throws past the flush)", async () => {
    setInsightsComputeForTests((async () => { throw new Error("boom"); }) as unknown as Parameters<typeof setInsightsComputeForTests>[0]);

    const events = await drain(new InsightsController().stream({ query: { root: "/proj" } }));

    expect(events).toEqual([{ type: "failed", message: "boom" }]);
  });
});

describe("InsightsController DI wiring", () => {
  it("resolves the injected ReportRegistry bound in the app context (not silently undefined)", async () => {
    // Guards the reconciliation: if @inject(REPORT_REGISTRY) failed to resolve the
    // bound instance, report tracking would silently vanish — a regression.
    const app = new RestApplication({});
    app.restController(InsightsController);
    const reg = new ReportRegistry();
    app.bind(REPORT_REGISTRY).to(reg);

    const ctrl = await app.get<InsightsController>("controllers.InsightsController");
    setInsightsComputeForTests(fakeCompute([["scanned", { sessions: 1 }]], []));
    await drain(ctrl.stream({ query: { root: "/wired" } }));

    expect(reg.list().find((r) => r.paramsKey === "/wired")).toMatchObject({ status: "done" });
  });
});
