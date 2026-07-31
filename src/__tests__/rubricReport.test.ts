// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { evaluateRubric, builtinRubrics, type Rubric } from "@agentgem/insight";
import type { WorkflowSignal, SessionSequence, ProcedureStep, DetectorFinding } from "@agentgem/insight";

const hygiene = builtinRubrics().find((r) => r.id === "hygiene")!;

function step(msgIndex: number, verb: string, arg: string): ProcedureStep {
  return { tool: "Bash", verb, arg, msgIndex };
}
function session(sessionId: string, atMs: number, steps: ProcedureStep[]): SessionSequence {
  return { sessionId, transcript: `${sessionId}.jsonl`, atMs, steps };
}
function signalOf(sessions: SessionSequence[]): WorkflowSignal {
  return {
    root: "/proj", flavor: "claude",
    sessions: { scanned: sessions.length, firstMs: 0, lastMs: 0, spanDays: 0 },
    artifacts: [], models: [], unresolved: [], coOccurrence: [], shapes: [], notes: [],
    sequences: { root: "/proj", sessions },
  };
}

// Session A trips retry-storm (3 identical consecutive steps); B is clean.
const A = session("A", 1, [step(0, "Bash", "x"), step(1, "Bash", "x"), step(2, "Bash", "x")]);
const B = session("B", 2, [step(0, "Read", "f")]);
const PROJECT = { scope: { kind: "project" as const, root: "/proj" } };

describe("evaluateRubric — cheap factors", () => {
  it("reports one row per factor incl. non-firing ones, and is not clean when something fires", async () => {
    const r = await evaluateRubric(signalOf([A, B]), hygiene, PROJECT);
    expect(r.factors.map((f) => f.id)).toEqual(["retry-storm", "thrash-loop", "no-verify-finish"]);
    expect(r.factors.find((f) => f.id === "retry-storm")!.count).toBeGreaterThanOrEqual(1);
    expect(r.factors.find((f) => f.id === "thrash-loop")!.count).toBe(0);   // non-firing row still present
    expect(r.clean).toBe(false);
    expect(r.degraded).toBe(false);
    expect(r.sessionsScanned).toBe(2);
  });

  it("perSession lists only sessions that tripped a factor (clean sessions omitted)", async () => {
    const r = await evaluateRubric(signalOf([A, B]), hygiene, PROJECT);
    expect(r.perSession?.map((p) => p.sessionId)).toEqual(["A"]);   // B is clean → not listed
    expect(r.perSession!.find((p) => p.sessionId === "A")!.factors.find((f) => f.id === "retry-storm")!.count).toBeGreaterThanOrEqual(1);
    expect(r.perSessionTruncated).toBe(false);
  });

  it("is clean (success state) when nothing fires, still listing the checks", async () => {
    const r = await evaluateRubric(signalOf([B]), hygiene, PROJECT);
    expect(r.clean).toBe(true);
    expect(r.factors.every((f) => f.count === 0)).toBe(true);
    expect(r.factors).toHaveLength(3);   // checks that passed are still shown
  });

  it("records unknown factor refs as skipped instead of throwing", async () => {
    const withUnknown: Rubric = { ...hygiene, id: "u", factors: [{ factor: "retry-storm" }, { factor: "does-not-exist" }] };
    const r = await evaluateRubric(signalOf([A]), withUnknown, PROJECT);
    expect(r.skippedFactors).toEqual([{ factor: "does-not-exist", reason: "unknown" }]);
    expect(r.factors.map((f) => f.id)).toEqual(["retry-storm"]);
  });

  it("throws when an aggregate-only rubric is run at session scope (hard guard)", async () => {
    const agg: Rubric = {
      id: "agg", title: "a", target: "overview",
      factors: [{ factor: "breadth-crit" }],
      criteria: [{ id: "breadth-crit", title: "b", question: "how broad?", advice: "x", granularity: "aggregate" }],
    };
    await expect(evaluateRubric(signalOf([A]), agg, { scope: { kind: "session", sessionId: "A", root: "/proj" } }))
      .rejects.toThrow(/aggregate-only/);
  });
});

describe("evaluateRubric — LLM criteria (Phase 2, injected judge)", () => {
  const withCrit: Rubric = {
    id: "rigor", title: "Rigor", target: "overview",
    factors: [{ factor: "retry-storm" }, { factor: "verified-real-case" }],
    criteria: [{ id: "verified-real-case", title: "Verified the real case?", question: "did they verify against the reported case?", advice: "verify the real thing", severity: "warn" }],
  };

  it("evaluates the criterion via the injected judge and reports it as a factor (not skipped)", async () => {
    const judge = async () => ({
      findings: [{ detectorId: "verified-real-case", sessionId: "A", transcript: "A.jsonl", atMs: 1, severity: "warn" as const, detail: "Verified the real case? — 1 step(s)", evidence: { msgIndices: [0] } } satisfies DetectorFinding],
      degraded: false, coverage: { eligible: 1, judged: 1, sampled: false, truncated: 0 }, applicability: new Map(),
    });
    const r = await evaluateRubric(signalOf([A]), withCrit, { ...PROJECT, judge });
    expect(r.skippedFactors).toEqual([]);   // criterion is resolved now, not skipped
    expect(r.factors.map((f) => f.id)).toEqual(["retry-storm", "verified-real-case"]);
    expect(r.factors.find((f) => f.id === "verified-real-case")!.count).toBe(1);
    expect(r.degraded).toBe(false);
  });

  // Sampling is a second, silent way criteria go unevaluated. `clean` already
  // refuses the all-clear when the agent failed; it must refuse it when the cap
  // dropped eligible sessions too, for exactly the same reason.
  it("is not clean when the judge sampled — the unjudged sessions could each trip a criterion", async () => {
    const judge = async () => ({
      findings: [] as DetectorFinding[], degraded: false,
      coverage: { eligible: 214, judged: 30, sampled: true, truncated: 0 }, applicability: new Map(),
    });
    const r = await evaluateRubric(signalOf([B]), withCrit, { ...PROJECT, judge });
    expect(r.degraded).toBe(false);        // the agent worked fine — this is NOT that failure
    expect(r.clean).toBe(false);           // but 184 eligible sessions were never checked
    expect(r.judgeCoverage).toEqual({ eligible: 214, judged: 30, sampled: true, truncated: 0 });
  });

  it("stays clean when the judge covered every eligible session", async () => {
    const judge = async () => ({
      findings: [] as DetectorFinding[], degraded: false,
      coverage: { eligible: 1, judged: 1, sampled: false, truncated: 0 },
      // The criterion was assessed and applied — an all-clear needs something to
      // have actually been checked, not merely an absence of findings.
      applicability: new Map([["verified-real-case", { judged: 1, applicable: 1 }]]),
    });
    const r = await evaluateRubric(signalOf([B]), withCrit, { ...PROJECT, judge });
    expect(r.clean).toBe(true);
  });

  it("decorates a criterion row with its denominator and leaves cheap rows undecorated", async () => {
    const judge = async () => ({
      findings: [] as DetectorFinding[], degraded: false,
      coverage: { eligible: 30, judged: 30, sampled: false, truncated: 0 },
      applicability: new Map([["verified-real-case", { judged: 30, applicable: 9 }]]),
    });
    const r = await evaluateRubric(signalOf([B]), withCrit, { ...PROJECT, judge });
    const crit = r.factors.find((f) => f.id === "verified-real-case")!;
    expect(crit.applicableSessions).toBe(9);
    expect(crit.judgedSessions).toBe(30);
    // Cheap detectors run over every session and have no applicability concept —
    // giving them a denominator would invent a distinction that doesn't exist.
    const cheap = r.factors.find((f) => f.id === "retry-storm")!;
    expect(cheap.applicableSessions).toBeUndefined();
    expect(cheap.judgedSessions).toBeUndefined();
  });

  // Zero applicable is not an all-clear: the criterion was never exercised, so
  // "nothing fired" says nothing about whether the agent behaves.
  it("is not clean when no criterion could be assessed anywhere", async () => {
    const judge = async () => ({
      findings: [] as DetectorFinding[], degraded: false,
      coverage: { eligible: 5, judged: 5, sampled: false, truncated: 0 },
      applicability: new Map([["verified-real-case", { judged: 5, applicable: 0 }]]),
    });
    const r = await evaluateRubric(signalOf([B]), withCrit, { ...PROJECT, judge });
    expect(r.degraded).toBe(false);   // the judge worked fine — this is NOT that failure
    expect(r.clean).toBe(false);
  });

  // A clipped session was only partly seen — the judge never got steps 81+. That is
  // the same "we did not actually check" as degraded and sampled, and it must refuse
  // the all-clear for the same reason.
  it("is not clean when a session was only partly examined", async () => {
    const judge = async () => ({
      findings: [] as DetectorFinding[], degraded: false,
      coverage: { eligible: 5, judged: 5, sampled: false, truncated: 1 },
      applicability: new Map([["verified-real-case", { judged: 4, applicable: 4 }]]),
    });
    const r = await evaluateRubric(signalOf([B]), withCrit, { ...PROJECT, judge });
    expect(r.degraded).toBe(false);
    expect(r.clean).toBe(false);
  });

  // Applicability is defined per session; an aggregate criterion has no per-session
  // denominator, so inventing one would be a number that means nothing.
  it("leaves an aggregate criterion undecorated even if the judge returns a denominator", async () => {
    const agg: Rubric = {
      id: "agg2", title: "Agg", target: "overview",
      factors: [{ factor: "breadth-crit" }],
      criteria: [{ id: "breadth-crit", title: "Breadth", question: "how broad?", advice: "x", granularity: "aggregate" }],
    };
    const judge = async () => ({
      findings: [] as DetectorFinding[], degraded: false,
      coverage: { eligible: 5, judged: 5, sampled: false, truncated: 0 },
      applicability: new Map([["breadth-crit", { judged: 5, applicable: 5 }]]),
    });
    const r = await evaluateRubric(signalOf([B]), agg, { ...PROJECT, judge });
    const row = r.factors.find((f) => f.id === "breadth-crit")!;
    expect(row.applicableSessions).toBeUndefined();
    expect(row.judgedSessions).toBeUndefined();
  });

  it("stays clean when one criterion never applied but another was assessed", async () => {
    const two: Rubric = {
      ...withCrit, id: "rigor2",
      factors: [{ factor: "verified-real-case" }, { factor: "second-crit" }],
      criteria: [
        withCrit.criteria![0],
        { id: "second-crit", title: "Second", question: "did the second thing happen?", advice: "do it" },
      ],
    };
    const judge = async () => ({
      findings: [] as DetectorFinding[], degraded: false,
      coverage: { eligible: 5, judged: 5, sampled: false, truncated: 0 },
      applicability: new Map([
        ["verified-real-case", { judged: 5, applicable: 0 }],
        ["second-crit", { judged: 5, applicable: 3 }],
      ]),
    });
    const r = await evaluateRubric(signalOf([B]), two, { ...PROJECT, judge });
    expect(r.clean).toBe(true);
  });

  it("marks the report degraded (and not clean) when the judge degrades — cheap findings still shown", async () => {
    const judge = async () => ({ findings: [] as DetectorFinding[], degraded: true, coverage: { eligible: 1, judged: 1, sampled: false, truncated: 0 }, applicability: new Map() });
    const r = await evaluateRubric(signalOf([A]), withCrit, { ...PROJECT, judge });
    expect(r.degraded).toBe(true);
    expect(r.clean).toBe(false);   // criteria unevaluated → can't claim all-clear
    expect(r.factors.find((f) => f.id === "retry-storm")!.count).toBeGreaterThanOrEqual(1);   // cheap factor still ran
    expect(r.factors.find((f) => f.id === "verified-real-case")!.count).toBe(0);
  });
});
