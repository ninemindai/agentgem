// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import {
  WorkflowController,
  setWorkflowComputeForTests,
} from "@agentgem/app/workflow.controller";
import { RestApplication } from "@agentback/rest";
import { isForegroundBusy } from "@agentgem/app/warm/orchestrator";
import { WorkflowEvent } from "@agentgem/app/workflow.stream.schema";
import { ReportRegistry, REPORT_REGISTRY } from "@agentgem/app/report/registry";
import type { WorkflowAnalysisResult } from "@agentgem/app/workflowCore";

afterEach(() => setWorkflowComputeForTests(null));

function fakeCompute(events: Array<[string, Record<string, unknown>?]>, deltas: string[], candidates: unknown[] = []) {
  return (async (_root: string, opts: { progress?: { onPhase?: (p: string, e?: Record<string, unknown>) => void; onDelta?: (t: string) => void } }) => {
    for (const [phase, extra] of events) opts.progress?.onPhase?.(phase, extra);
    for (const d of deltas) opts.progress?.onDelta?.(d);
    return {
      payload: { candidates, gaps: [], distilled: [], reflections: [], signalSummary: { sessionsScanned: 0, spanDays: 0, notes: null }, degraded: false },
      cached: false,
      updatedAt: 0,
    } as unknown as WorkflowAnalysisResult;
  }) as unknown as Parameters<typeof setWorkflowComputeForTests>[0];
}

async function drain(gen: AsyncGenerator<unknown>) {
  const out: unknown[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("WorkflowController.stream (streamOf route)", () => {
  it("maps push-style progress into a validated phase/delta/done union", async () => {
    const CAND = { name: "auth", description: "d", confidence: "high", include: [] };
    setWorkflowComputeForTests(fakeCompute([["scanning"], ["scanned", { transcripts: 3, sessions: 2 }]], ["thinking…"], [CAND]));

    const events = await drain(new WorkflowController().stream({ query: { root: "/proj" } }));

    expect(events.map((e) => (e as { type: string }).type)).toEqual(["phase", "phase", "delta", "done"]);
    for (const e of events) expect(WorkflowEvent.safeParse(e).success).toBe(true);
    expect(events[1]).toMatchObject({ type: "phase", phase: "scanned", transcripts: 3, sessions: 2 });
    expect(events[3]).toMatchObject({ type: "done", cached: false, candidates: [CAND] });
  });

  it("records the run under kind 'analyze' in an injected ReportRegistry", async () => {
    const reg = new ReportRegistry();
    setWorkflowComputeForTests(fakeCompute([["scanned", { sessions: 2 }]], []));

    await drain(new WorkflowController(reg).stream({ query: { root: "/proj" } }));

    expect(reg.list().find((r) => r.kind === "analyze" && r.paramsKey === "/proj")).toMatchObject({ status: "done", params: { root: "/proj" } });
  });

  it("marks the registry run failed when compute throws", async () => {
    const reg = new ReportRegistry();
    setWorkflowComputeForTests((async () => { throw new Error("boom"); }) as unknown as Parameters<typeof setWorkflowComputeForTests>[0]);

    const events = await drain(new WorkflowController(reg).stream({ query: { root: "/p" } }));

    expect(events).toEqual([{ type: "failed", message: "boom" }]);
    expect(reg.list().find((r) => r.kind === "analyze" && r.paramsKey === "/p")).toMatchObject({ status: "failed", error: "boom" });
  });

  it("holds the foreground gate until compute settles, even after client disconnect", async () => {
    expect(isForegroundBusy()).toBe(false);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    setWorkflowComputeForTests((async (_root: string, opts: { progress?: { onPhase?: (p: string) => void } }) => {
      opts.progress?.onPhase?.("scanning");
      await gate;
      return { payload: { candidates: [], gaps: [], distilled: [], reflections: [], signalSummary: { sessionsScanned: 0, spanDays: 0, notes: null }, degraded: false }, cached: false, updatedAt: 0 } as unknown as WorkflowAnalysisResult;
    }) as unknown as Parameters<typeof setWorkflowComputeForTests>[0]);

    const gen = new WorkflowController().stream({ query: { root: "/dc" } });
    await gen.next();
    expect(isForegroundBusy()).toBe(true);
    await gen.return(undefined);
    expect(isForegroundBusy()).toBe(true); // still held — compute runs on in the background
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(isForegroundBusy()).toBe(false);
  });
});

describe("WorkflowController DI wiring", () => {
  it("resolves the injected ReportRegistry bound in the app context", async () => {
    const app = new RestApplication({});
    app.restController(WorkflowController);
    const reg = new ReportRegistry();
    app.bind(REPORT_REGISTRY).to(reg);

    const ctrl = await app.get<WorkflowController>("controllers.WorkflowController");
    setWorkflowComputeForTests(fakeCompute([["scanned", { sessions: 1 }]], []));
    await drain(ctrl.stream({ query: { root: "/wired" } }));

    expect(reg.list().find((r) => r.paramsKey === "/wired")).toMatchObject({ status: "done" });
  });
});
