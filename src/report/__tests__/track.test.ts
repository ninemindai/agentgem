import { describe, it, expect } from "vitest";
import { ReportRegistry } from "../registry.js";
import { makeTracker, insightsParamsKey, rubricParamsKey } from "../track.js";

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

describe("paramsKey derivation", () => {
  it("insights key is the root", () => {
    expect(insightsParamsKey({ root: "/proj" })).toBe("/proj");
  });
  it("rubric key composes rubric:scope:root:sessionId", () => {
    expect(rubricParamsKey({ rubric: "hygiene", scope: "project", root: "/p" })).toBe("hygiene:project:/p:");
    expect(rubricParamsKey({ rubric: "hygiene", scope: "all" })).toBe("hygiene:all::");
  });
});
