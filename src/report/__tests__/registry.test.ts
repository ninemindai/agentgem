import { describe, it, expect } from "vitest";
import { ReportRegistry } from "../registry.js";

describe("ReportRegistry", () => {
  it("begin marks a run running and list() exposes it newest-first", () => {
    let t = 100;
    const r = new ReportRegistry({ now: () => t });
    r.begin("insights", "/a", { root: "/a" });
    t = 200;
    r.begin("rubric", "x:all::", { rubric: "x", scope: "all" });
    const list = r.list();
    expect(list.map((x) => x.kind)).toEqual(["rubric", "insights"]);   // newest first
    expect(list[1]).toMatchObject({ id: "insights:/a", status: "running", params: { root: "/a" } });
  });

  it("phase updates the running record", () => {
    const r = new ReportRegistry();
    r.begin("insights", "/a", { root: "/a" });
    r.phase("insights", "/a", "judging");
    expect(r.get("insights", "/a")?.phase).toBe("judging");
  });

  it("finish records terminal status + finishedAt, and a re-begin restarts it", () => {
    let t = 1;
    const r = new ReportRegistry({ now: () => t });
    r.begin("insights", "/a", { root: "/a" });
    t = 5; r.finish("insights", "/a", "done");
    expect(r.get("insights", "/a")).toMatchObject({ status: "done", finishedAt: 5 });
    t = 9; r.begin("insights", "/a", { root: "/a" });   // Re-run
    expect(r.get("insights", "/a")).toMatchObject({ status: "running", startedAt: 9, finishedAt: undefined });
  });

  it("finish with an error message records it as failed", () => {
    const r = new ReportRegistry();
    r.begin("rubric", "k", { rubric: "r" });
    r.finish("rubric", "k", "failed", "adapter timeout");
    expect(r.get("rubric", "k")).toMatchObject({ status: "failed", error: "adapter timeout" });
  });

  it("sweep evicts finished runs past the TTL but keeps running ones", () => {
    let t = 1000;
    const r = new ReportRegistry({ now: () => t, ttlMs: 100 });
    r.begin("insights", "/done", { root: "/done" });
    r.finish("insights", "/done", "done");
    r.begin("insights", "/live", { root: "/live" });   // still running
    t = 2000;
    r.sweep();
    expect(r.get("insights", "/done")).toBeUndefined();
    expect(r.get("insights", "/live")).toBeDefined();
  });
});
