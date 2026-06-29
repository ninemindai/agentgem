import { describe, it, expect } from "vitest";
import { isPortable, scoreProject, aggregateScorecard, collectScorecard, type ProjectLoad, type ScorecardDeps } from "../scorecard.js";
import type { ProcedureCandidate } from "../distillTypes.js";
import type { WorkflowSignal } from "../workflowScan.js";

// Minimal candidate factory — only the fields scorecard.ts reads.
function cand(over: Partial<ProcedureCandidate> & { key: string }): ProcedureCandidate {
  return {
    key: over.key,
    verbs: over.verbs ?? ["a", "b", "c"],
    sessions: over.sessions ?? 3,
    sampleSessionIdx: 0,
    sessionIdxs: [0],
    sample: { steps: [], sessionId: "s", transcript: "t.jsonl", atMs: 0 } as any,
    provenance: { occurrences: [] },
    priorConfidence: over.priorConfidence ?? "low",
    skeleton: { name: over.skeleton?.name ?? over.key, tools: over.skeleton?.tools ?? ["Bash"] } as any,
  } as ProcedureCandidate;
}

function sig(root: string): WorkflowSignal {
  return { root, flavor: "claude", sessions: { scanned: 5, firstMs: 0, lastMs: 0, spanDays: 7 },
    artifacts: [], models: [], unresolved: [], coOccurrence: [], shapes: [], notes: [] };
}

describe("isPortable", () => {
  it("is true for a high-confidence candidate using any non-local tool", () => {
    expect(isPortable(cand({ key: "k1", priorConfidence: "high", skeleton: { name: "k1", tools: ["WebFetch", "Edit"] } as any }))).toBe(true);
    expect(isPortable(cand({ key: "k2", priorConfidence: "high", skeleton: { name: "k2", tools: ["mcp__pw__click"] } as any }))).toBe(true);
    expect(isPortable(cand({ key: "k3", priorConfidence: "high", skeleton: { name: "k3", tools: ["AskUserQuestion", "Bash"] } as any }))).toBe(true);
  });
  it("is false when not battle-tested, or tools are repo-local only", () => {
    expect(isPortable(cand({ key: "k4", priorConfidence: "medium", skeleton: { name: "k4", tools: ["WebFetch"] } as any }))).toBe(false);
    expect(isPortable(cand({ key: "k5", priorConfidence: "high", skeleton: { name: "k5", tools: ["Edit", "Bash", "Read"] } as any }))).toBe(false);
  });
});

describe("scoreProject", () => {
  it("counts breadth, battle-tested, and portable for one project", () => {
    const load: ProjectLoad = {
      root: "/r/alpha", label: "alpha", signal: sig("/r/alpha"), reflections: [],
      candidates: [
        cand({ key: "k1", priorConfidence: "high", skeleton: { name: "k1", tools: ["Skill"] } as any }),
        cand({ key: "k2", priorConfidence: "high", skeleton: { name: "k2", tools: ["Edit"] } as any }),
        cand({ key: "k3", priorConfidence: "low", skeleton: { name: "k3", tools: ["Bash"] } as any }),
      ],
    };
    const p = scoreProject(load);
    expect(p).toMatchObject({ root: "/r/alpha", label: "alpha", breadth: 3, battleTested: 2, portable: 1 });
    // workflows sorted high-before-low; first entry is the high-confidence k1
    expect(p.workflows[0]).toEqual({ key: "k1", name: "k1", confidence: "high", portable: true });
    expect(p.workflows[1]).toEqual({ key: "k2", name: "k2", confidence: "high", portable: false });
    expect(p.workflows[2]).toEqual({ key: "k3", name: "k3", confidence: "low", portable: false });
  });
});

describe("aggregateScorecard", () => {
  it("dedups breadth by candidate key across projects and sums tiers", () => {
    const shared = cand({ key: "shared", priorConfidence: "high", skeleton: { name: "shared", tools: ["Skill"] } as any });
    const a: ProjectLoad = { root: "/r/a", label: "a", signal: sig("/r/a"), reflections: [{ kind: "recurring-pattern", detail: "gap-A", importance: "high", provenance: { occurrences: [] } }],
      candidates: [shared, cand({ key: "x", priorConfidence: "low" })] };
    const b: ProjectLoad = { root: "/r/b", label: "b", signal: sig("/r/b"), reflections: [],
      candidates: [shared] };
    const sc = aggregateScorecard([a, b], 1234, false);
    expect(sc.breadth).toBe(2);            // {shared, x} — "shared" not double-counted
    expect(sc.battleTested).toBe(2);       // shared(high) in a + shared(high) in b
    expect(sc.portable).toBe(2);
    expect(sc.gaps).toContain("gap-A");
    expect(sc.projects).toHaveLength(2);
    expect(sc).toMatchObject({ generatedAtMs: 1234, degraded: false });
  });
});

describe("collectScorecard", () => {
  it("composes discover + per-project load into a Scorecard via injected deps", () => {
    const deps: ScorecardDeps = {
      discover: () => [{ path: "/r/a" }, { path: "/r/b" }],
      loadProject: (root) => ({
        signal: sig(root),
        reflections: [],
        candidates: [cand({ key: `${root}-k`, priorConfidence: "high", skeleton: { name: "k", tools: ["Skill"] } as any })],
      }),
    };
    const sc = collectScorecard(undefined, undefined, 99, deps);
    expect(sc.projects.map((p) => p.root)).toEqual(["/r/a", "/r/b"]);
    expect(sc.breadth).toBe(2);
    expect(sc.battleTested).toBe(2);
    expect(sc.portable).toBe(2);
    expect(sc.degraded).toBe(false);
  });

  it("restricts to the given projects and marks degraded when a load fails", () => {
    const deps: ScorecardDeps = {
      discover: () => [{ path: "/r/a" }, { path: "/r/b" }],
      loadProject: (root) => (root === "/r/a" ? { signal: sig(root), reflections: [], candidates: [] } : null),
    };
    const sc = collectScorecard(undefined, ["/r/a"], 1, deps);
    expect(sc.projects.map((p) => p.root)).toEqual(["/r/a"]);
    expect(sc.degraded).toBe(false);
    const sc2 = collectScorecard(undefined, undefined, 1, deps);
    expect(sc2.degraded).toBe(true);   // /r/b load returned null
  });

  it("caps the discover-all path to the 12 most-recently-used projects", () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ path: `/r/p${i}`, lastUsed: `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00Z` }));
    const deps: ScorecardDeps = {
      discover: () => many,
      loadProject: (root) => ({ signal: sig(root), reflections: [], candidates: [] }),
    };
    const sc = collectScorecard(undefined, undefined, 1, deps);
    expect(sc.projects).toHaveLength(12);
    // newest (p14, 2026-06-15) included; oldest (p0, 2026-06-01) dropped
    expect(sc.projects.map((p) => p.root)).toContain("/r/p14");
    expect(sc.projects.map((p) => p.root)).not.toContain("/r/p0");
  });

  it("does NOT cap an explicit projects list", () => {
    const roots = Array.from({ length: 15 }, (_, i) => `/r/e${i}`);
    const deps: ScorecardDeps = {
      discover: () => [],
      loadProject: (root) => ({ signal: sig(root), reflections: [], candidates: [] }),
    };
    const sc = collectScorecard(undefined, roots, 1, deps);
    expect(sc.projects).toHaveLength(15);
  });
});
