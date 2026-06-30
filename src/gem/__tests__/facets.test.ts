// src/gem/__tests__/facets.test.ts
import { describe, it, expect } from "vitest";
import { deterministicFacets, validateFacets } from "@agentgem/insight";
import type { WorkflowSignal, SessionSequence } from "@agentgem/insight";

function sess(id: string, task: string | null, model?: string): SessionSequence {
  const base: SessionSequence = { steps: [], sessionId: id, transcript: `${id}.jsonl`, atMs: 100, model };
  return task === null ? base : { ...base, missionHint: { task, outcome: "" } };
}

function signalWith(sessions: SessionSequence[] | null): WorkflowSignal {
  const sig: WorkflowSignal = {
    root: "/r", flavor: "claude",
    sessions: { scanned: sessions?.length ?? 0, firstMs: 0, lastMs: 0, spanDays: 0 },
    models: [], artifacts: [], unresolved: [], coOccurrence: [], shapes: [], notes: [],
  };
  if (sessions) sig.sequences = { root: "/r", sessions };
  return sig;
}

describe("deterministicFacets", () => {
  it("emits one heuristic facet per missioned session, carrying provenance", () => {
    const out = deterministicFacets(signalWith([sess("a", "Ship the auth flow"), sess("b", "Fix DNS")]));
    expect(out).toHaveLength(2);
    expect(out.every((f) => f.origin === "heuristic")).toBe(true);
    expect(out.every((f) => f.outcome === "partially_achieved")).toBe(true); // neutral: can't judge without the agent
    const a = out.find((f) => f.sessionId === "a")!;
    expect(a.underlying_goal).toBe("Ship the auth flow");
    expect(a.transcript).toBe("a.jsonl");
    expect(a.atMs).toBe(100);
  });

  it("skips sessions without a mission hint", () => {
    const out = deterministicFacets(signalWith([sess("a", "Ship the auth flow"), sess("b", null)]));
    expect(out).toHaveLength(1);
    expect(out[0].sessionId).toBe("a");
  });

  it("carries the session's model", () => {
    const out = deterministicFacets(signalWith([sess("a", "Ship the auth flow", "claude-opus-4-8")]));
    expect(out[0].model).toBe("claude-opus-4-8");
  });

  it("returns [] when the signal has no sequences", () => {
    expect(deterministicFacets(signalWith(null))).toEqual([]);
  });
});

describe("validateFacets", () => {
  const sig = signalWith([sess("a", "Ship the auth flow", "claude-opus-4-8"), sess("b", "Fix DNS")]);

  it("accepts well-formed facets, stamps llm origin and backfills provenance + model", () => {
    const raw = JSON.stringify({ facets: [
      { sessionId: "a", underlying_goal: "Ship GitHub device-flow auth", outcome: "mostly_achieved", friction_detail: "", brief_summary: "Built and merged auth binding.", model: "gpt-spoofed" },
    ] });
    const out = validateFacets(raw, sig);
    expect(out).toHaveLength(1);
    expect(out[0].origin).toBe("llm");
    expect(out[0].outcome).toBe("mostly_achieved");
    expect(out[0].transcript).toBe("a.jsonl"); // backfilled from the signal, not trusted from the agent
    expect(out[0].atMs).toBe(100);
    expect(out[0].model).toBe("claude-opus-4-8"); // from the signal, NOT the agent's "gpt-spoofed"
  });

  it("drops a facet whose sessionId is not in the signal but keeps valid ones", () => {
    const raw = JSON.stringify({ facets: [
      { sessionId: "a", underlying_goal: "g", outcome: "mostly_achieved", friction_detail: "", brief_summary: "s" },
      { sessionId: "zzz", underlying_goal: "g", outcome: "mostly_achieved", friction_detail: "", brief_summary: "s" },
    ] });
    const out = validateFacets(raw, sig);
    expect(out).toHaveLength(1);
    expect(out[0].sessionId).toBe("a");
  });

  it("drops a facet with an invalid outcome enum but keeps valid ones", () => {
    const raw = JSON.stringify({ facets: [
      { sessionId: "a", underlying_goal: "g", outcome: "totally_crushed_it", friction_detail: "", brief_summary: "s" },
      { sessionId: "b", underlying_goal: "g", outcome: "not_achieved", friction_detail: "", brief_summary: "s" },
    ] });
    const out = validateFacets(raw, sig);
    expect(out).toHaveLength(1);
    expect(out[0].sessionId).toBe("b");
  });

  it("falls back to deterministic facets on non-JSON", () => {
    const out = validateFacets("not json at all", sig);
    expect(out).toHaveLength(2);
    expect(out.every((f) => f.origin === "heuristic")).toBe(true);
  });

  it("falls back to deterministic facets when the structure is valid but zero facets survive", () => {
    const raw = JSON.stringify({ facets: [
      { sessionId: "ghost", underlying_goal: "g", outcome: "mostly_achieved", friction_detail: "", brief_summary: "s" },
    ] });
    const out = validateFacets(raw, sig);
    expect(out).toHaveLength(2);
    expect(out.every((f) => f.origin === "heuristic")).toBe(true);
  });
});
