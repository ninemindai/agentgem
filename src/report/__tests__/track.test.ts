import { describe, it, expect } from "vitest";
import { ReportRegistry } from "../registry.js";
import { makeTracker, trackerFor, insightsParamsKey, rubricParamsKey } from "../track.js";

describe("makeTracker", () => {
  it("registers begin on creation and forwards phase/done to the registry", () => {
    const reg = new ReportRegistry();
    const t = makeTracker(reg, "insights", "/a", { root: "/a" });
    expect(reg.get("insights", "/a")?.status).toBe("running");
    t.phase("judging");
    expect(reg.get("insights", "/a")?.phase).toBe("judging");
    t.done();
    expect(reg.get("insights", "/a")?.status).toBe("done");
  });

  it("forwards failed with the message", () => {
    const reg = new ReportRegistry();
    const t = makeTracker(reg, "rubric", "k", { rubric: "r" });
    t.failed("boom");
    expect(reg.get("rubric", "k")).toMatchObject({ status: "failed", error: "boom" });
  });
});

describe("trackerFor (reattach guard)", () => {
  it("skips tracking a non-fresh open of an already-terminal run (reattach / re-view)", () => {
    const reg = new ReportRegistry();
    reg.begin("insights", "/p", { root: "/p" });
    reg.finish("insights", "/p", "done");
    const startedBefore = reg.get("insights", "/p")!.startedAt;
    const t = trackerFor(reg, "insights", "/p", { root: "/p" }, false);
    expect(t).toBeUndefined();
    // The done record is left intact — no re-begin, so startedAt/status don't change
    // and detectReportDone can't see a spurious new completion.
    expect(reg.get("insights", "/p")).toMatchObject({ status: "done", startedAt: startedBefore });
  });

  it("tracks a fresh open (Re-run) even when a terminal run exists", () => {
    const reg = new ReportRegistry();
    reg.begin("insights", "/p", { root: "/p" });
    reg.finish("insights", "/p", "done");
    const t = trackerFor(reg, "insights", "/p", { root: "/p" }, true);
    expect(t).toBeDefined();
    expect(reg.get("insights", "/p")?.status).toBe("running"); // Re-run re-begins it
  });

  it("tracks a non-fresh FIRST open (no existing run)", () => {
    const reg = new ReportRegistry();
    const t = trackerFor(reg, "insights", "/p", { root: "/p" }, false);
    expect(t).toBeDefined();
    expect(reg.get("insights", "/p")?.status).toBe("running");
  });

  it("tracks a non-fresh open of a still-running run", () => {
    const reg = new ReportRegistry();
    reg.begin("insights", "/p", { root: "/p" });
    const t = trackerFor(reg, "insights", "/p", { root: "/p" }, false);
    expect(t).toBeDefined();
  });
});

describe("paramsKey derivation", () => {
  it("insights key is the root", () => {
    expect(insightsParamsKey({ root: "/proj" })).toBe("/proj");
  });
  it("rubric key composes rubric:scope:root:sessionId", () => {
    expect(rubricParamsKey({ rubric: "hygiene", scope: "project", root: "/p" })).toBe("hygiene:project:/p:");
    expect(rubricParamsKey({ rubric: "hygiene", scope: "all" })).toBe("hygiene:all::");
  });
});
