// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { evaluateRubric, builtinRubrics, type Rubric } from "@agentgem/insight";
import type { WorkflowSignal, SessionSequence, ProcedureStep } from "@agentgem/insight";

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

describe("evaluateRubric (cheap factors, Phase 1)", () => {
  it("reports one row per factor incl. non-firing ones, and is not clean when something fires", () => {
    const r = evaluateRubric(signalOf([A, B]), hygiene, { scope: { kind: "project", root: "/proj" } });
    expect(r.factors.map((f) => f.id)).toEqual(["retry-storm", "thrash-loop", "no-verify-finish"]);
    const retry = r.factors.find((f) => f.id === "retry-storm")!;
    expect(retry.count).toBeGreaterThanOrEqual(1);
    expect(r.factors.find((f) => f.id === "thrash-loop")!.count).toBe(0);   // non-firing row still present
    expect(r.clean).toBe(false);
    expect(r.degraded).toBe(false);
    expect(r.sessionsScanned).toBe(2);
  });

  it("populates perSession for a session-granular rubric, keyed to each transcript", () => {
    const r = evaluateRubric(signalOf([A, B]), hygiene, { scope: { kind: "project", root: "/proj" } });
    expect(r.perSession?.map((p) => p.sessionId)).toEqual(["A", "B"]);
    const aRetry = r.perSession!.find((p) => p.sessionId === "A")!.factors.find((f) => f.id === "retry-storm")!;
    const bRetry = r.perSession!.find((p) => p.sessionId === "B")!.factors.find((f) => f.id === "retry-storm")!;
    expect(aRetry.count).toBeGreaterThanOrEqual(1);
    expect(bRetry.count).toBe(0);
  });

  it("is clean (success state) when nothing fires, still listing the checks", () => {
    const r = evaluateRubric(signalOf([B]), hygiene, { scope: { kind: "project", root: "/proj" } });
    expect(r.clean).toBe(true);
    expect(r.factors.every((f) => f.count === 0)).toBe(true);
    expect(r.factors).toHaveLength(3);   // checks that passed are still shown
  });

  it("records unknown factor refs as skipped instead of throwing", () => {
    const withUnknown: Rubric = { ...hygiene, id: "u", factors: [{ factor: "retry-storm" }, { factor: "does-not-exist" }] };
    const r = evaluateRubric(signalOf([A]), withUnknown, { scope: { kind: "project", root: "/proj" } });
    expect(r.skippedFactors).toEqual([{ factor: "does-not-exist", reason: "unknown" }]);
    expect(r.factors.map((f) => f.id)).toEqual(["retry-storm"]);
  });

  it("records inline LLM criteria as skipped in Phase 1", () => {
    const withCrit: Rubric = {
      id: "sell", title: "s", target: "overview",
      factors: [{ factor: "retry-storm" }, { factor: "general-enough" }],
      criteria: [{ id: "general-enough", title: "General?", question: "reusable elsewhere?", advice: "generalize", granularity: "session" }],
    };
    const r = evaluateRubric(signalOf([A]), withCrit, { scope: { kind: "project", root: "/proj" } });
    expect(r.skippedFactors).toEqual([{ factor: "general-enough", reason: "llm-phase2" }]);
  });

  it("throws when an aggregate-only rubric is run at session scope (hard guard)", () => {
    const agg: Rubric = {
      id: "agg", title: "a", target: "overview",
      factors: [{ factor: "breadth-crit" }],
      criteria: [{ id: "breadth-crit", title: "b", question: "how broad?", advice: "x", granularity: "aggregate" }],
    };
    expect(() => evaluateRubric(signalOf([A]), agg, { scope: { kind: "session", sessionId: "A", root: "/proj" } }))
      .toThrow(/aggregate-only/);
  });
});
