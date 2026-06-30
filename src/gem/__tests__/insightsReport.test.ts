// src/gem/__tests__/insightsReport.test.ts
import { describe, it, expect } from "vitest";
import { synthesizeInsights } from "@agentgem/insight";
import type { SessionFacet, SessionOutcome } from "@agentgem/insight";

function facet(sessionId: string, outcome: SessionOutcome, friction = "", model?: string): SessionFacet {
  return {
    sessionId, transcript: `${sessionId}.jsonl`, atMs: 0,
    underlying_goal: `goal-${sessionId}`,
    brief_summary: `summary-${sessionId}`,
    outcome, friction_detail: friction, model, origin: "llm",
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

  it("buckets outcomes by model, excluding facets with no model", () => {
    const r = synthesizeInsights([
      facet("a", "mostly_achieved", "", "claude-opus-4-8"),
      facet("b", "not_achieved", "", "claude-opus-4-8"),
      facet("c", "mostly_achieved", "", "gpt-5.1"),
      facet("d", "mostly_achieved", ""), // no model → excluded
    ]);
    const opus = r.by_model.find((m) => m.model === "claude-opus-4-8")!;
    expect(opus).toMatchObject({ mostly: 1, not: 1, total: 2 });
    const gpt = r.by_model.find((m) => m.model === "gpt-5.1")!;
    expect(gpt).toMatchObject({ mostly: 1, total: 1 });
    expect(r.by_model).toHaveLength(2); // the model-less facet contributes no bucket
  });

  it("returns a zeroed report for no facets", () => {
    const r = synthesizeInsights([]);
    expect(r.totals.sessions).toBe(0);
    expect(r.publish_candidates).toEqual([]);
    expect(r.friction).toEqual([]);
  });

  it("includes a deterministic narrative summarizing the outcomes", () => {
    const r = synthesizeInsights([facet("a", "mostly_achieved"), facet("b", "not_achieved")]);
    expect(r.narrative).toContain("2"); // session count
    expect(r.narrative.length).toBeGreaterThan(0);
  });

  it("gives a no-sessions narrative when empty", () => {
    expect(synthesizeInsights([]).narrative.toLowerCase()).toContain("no session");
  });
});
