// src/gem/__tests__/insightsReport.test.ts
import { describe, it, expect } from "vitest";
import { synthesizeInsights } from "@agentgem/insight";
import type { SessionFacet, SessionOutcome } from "@agentgem/insight";

function facet(sessionId: string, outcome: SessionOutcome, friction = ""): SessionFacet {
  return {
    sessionId, transcript: `${sessionId}.jsonl`, atMs: 0,
    underlying_goal: `goal-${sessionId}`,
    brief_summary: `summary-${sessionId}`,
    outcome, friction_detail: friction, origin: "llm",
  };
}

describe("synthesizeInsights", () => {
  it("counts outcomes and summarizes them", () => {
    const r = synthesizeInsights([
      facet("a", "mostly_achieved"), facet("b", "mostly_achieved"),
      facet("c", "partially_achieved"), facet("d", "not_achieved"),
    ]);
    expect(r.totals).toEqual({ sessions: 4, mostly: 2, partially: 1, not: 1 });
    expect(r.outcomes_summary).toContain("4");
  });

  it("surfaces mostly_achieved sessions as publish candidates carrying their goal+summary", () => {
    const r = synthesizeInsights([
      facet("a", "mostly_achieved"), facet("b", "partially_achieved"), facet("c", "not_achieved"),
    ]);
    expect(r.publish_candidates).toHaveLength(1);
    expect(r.publish_candidates[0].sessionId).toBe("a");
    expect(r.publish_candidates[0].goal).toBe("goal-a");
    expect(r.publish_candidates[0].why).toContain("summary-a");
  });

  it("lists only facets that recorded friction", () => {
    const r = synthesizeInsights([
      facet("a", "mostly_achieved", "interrupted mid-generation"),
      facet("b", "partially_achieved", ""),
    ]);
    expect(r.friction).toHaveLength(1);
    expect(r.friction[0].sessionId).toBe("a");
    expect(r.friction[0].detail).toBe("interrupted mid-generation");
  });

  it("returns a zeroed report for no facets", () => {
    const r = synthesizeInsights([]);
    expect(r.totals.sessions).toBe(0);
    expect(r.publish_candidates).toEqual([]);
    expect(r.friction).toEqual([]);
  });
});
