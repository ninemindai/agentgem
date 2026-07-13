import { describe, it, expect } from "vitest";
import { detectReportDone, type ReportSnapshot } from "../events.js";

const snap = (terminal: Record<string, "done" | "failed">, kindOf: Record<string, string> = {}): ReportSnapshot => ({ terminal, kindOf });

describe("detectReportDone", () => {
  it("first snapshot: fires for a run that finished AFTER the provider mounted (baseline fix)", () => {
    // A cached run that completes between mount and first poll should still notify.
    const next = snap({ a: "done" }, { a: "insights" });
    const evs = detectReportDone(null, next, { firstBaselineAt: 100, startedAt: { a: 150 } });   // started after mount
    expect(evs).toHaveLength(1);
  });

  it("first snapshot: does NOT fire for a run that was already terminal before mount", () => {
    const next = snap({ a: "done" }, { a: "insights" });
    const evs = detectReportDone(null, next, { firstBaselineAt: 100, startedAt: { a: 50 } });   // started before mount
    expect(evs).toEqual([]);
  });

  it("fires one event per newly-terminal run on a normal transition", () => {
    const evs = detectReportDone(snap({}, { a: "insights" }), snap({ a: "done" }, { a: "insights" }));
    expect(evs).toHaveLength(1);
    expect(evs[0].title).toMatch(/Insights/);
    expect(evs[0].message).toMatch(/ready/);
  });

  it("does not re-fire for an already-terminal run", () => {
    const evs = detectReportDone(snap({ a: "done" }, { a: "insights" }), snap({ a: "done", b: "failed" }, { a: "insights", b: "rubric" }));
    expect(evs).toHaveLength(1);
    expect(evs[0].message).toMatch(/failed/);
  });
});
