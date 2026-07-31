// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { judgeCriteria, validateCriterionResults } from "@agentgem/insight";
import type { WorkflowSignal, SessionSequence, ProcedureStep, LlmCriterion, AcpConnectFn } from "@agentgem/insight";

function step(msgIndex: number): ProcedureStep { return { tool: "Bash", verb: "Bash", arg: `cmd${msgIndex}`, msgIndex }; }
function sess(id: string, atMs: number, indices: number[]): SessionSequence {
  return { sessionId: id, transcript: `${id}.jsonl`, atMs, steps: indices.map(step) };
}
function signalOf(sessions: SessionSequence[]): WorkflowSignal {
  return {
    root: "/r", flavor: "claude",
    sessions: { scanned: sessions.length, firstMs: 0, lastMs: 0, spanDays: 0 },
    artifacts: [], models: [], unresolved: [], coOccurrence: [], shapes: [], notes: [],
    sequences: { root: "/r", sessions },
  };
}
const CRIT: LlmCriterion[] = [{ id: "c1", title: "Verified?", question: "did they verify?", advice: "verify", severity: "warn" }];

// Fake agent: asserts plan mode, returns canned JSON.
function fakeConnect(canned: string): AcpConnectFn {
  return async () => ({
    ctx: { async open() {
      let mode = "default";
      return {
        async setMode(m: string) { mode = m; },
        async promptText() { if (mode !== "plan") throw new Error("not plan"); return canned; },
        dispose() {},
      };
    } },
    close() {},
  });
}

describe("validateCriterionResults (evidence contract)", () => {
  const A = sess("A", 1, [0, 1, 2]);
  it("drops hallucinated msgIndices, keeping only ones that exist in the session", () => {
    const text = JSON.stringify({ results: [{ sessionId: "A", criterionId: "c1", fired: true, msgIndices: [1, 99, 2] }] });
    const { findings: f } = validateCriterionResults(text, [A], CRIT);
    expect(f).toHaveLength(1);
    expect(f[0].evidence.msgIndices).toEqual([1, 2]);   // 99 dropped
    expect(f[0].detectorId).toBe("c1");
    expect(f[0].severity).toBe("warn");
    expect(f[0].detail).not.toContain("cmd");           // coords-only detail, never step args
  });

  it("keeps a finding with empty evidence when ALL cited indices are hallucinated (detail-only)", () => {
    const text = JSON.stringify({ results: [{ sessionId: "A", criterionId: "c1", fired: true, msgIndices: [42, 43] }] });
    const { findings: f } = validateCriterionResults(text, [A], CRIT);
    expect(f).toHaveLength(1);
    expect(f[0].evidence.msgIndices).toEqual([]);
    expect(f[0].detail).toMatch(/evidence unresolved/);
  });

  it("drops unknown sessions, unknown criteria, and fired:false", () => {
    const text = JSON.stringify({ results: [
      { sessionId: "Z", criterionId: "c1", fired: true, msgIndices: [0] },   // invented session
      { sessionId: "A", criterionId: "c9", fired: true, msgIndices: [0] },   // unknown criterion
      { sessionId: "A", criterionId: "c1", fired: false, msgIndices: [0] },  // didn't fire
    ] });
    expect(validateCriterionResults(text, [A], CRIT).findings).toEqual([]);
  });

  it("returns [] on non-JSON / malformed output", () => {
    expect(validateCriterionResults("not json", [A], CRIT).findings).toEqual([]);
    expect(validateCriterionResults(JSON.stringify({ nope: 1 }), [A], CRIT).findings).toEqual([]);
  });

  // An unusable reply is NOT a judgment. Without ok:false the caller cannot tell
  // "the judge found nothing" from "the judge said nothing we could read", and any
  // accounting that reads absence as a pass would mint verdicts out of garbage.
  it("reports ok:false when the reply is not JSON", () => {
    const r = validateCriterionResults("I was unable to assess these sessions.", [A], CRIT);
    expect(r.ok).toBe(false);
    expect(r.findings).toEqual([]);
  });

  it("reports ok:false when the reply parses but carries no results array", () => {
    expect(validateCriterionResults(JSON.stringify({ nope: 1 }), [A], CRIT).ok).toBe(false);
  });

  // The contract asks for BOTH keys. A reply carrying only `results` is the OLD
  // shape: it yields no roster, so every session reads as unjudged and the report
  // silently loses its denominators. Treat it as unreadable so the run degrades
  // loudly instead of quietly reporting nothing-to-see-here.
  it("reports ok:false when the reply omits the session roster", () => {
    expect(validateCriterionResults(JSON.stringify({ results: [] }), [A], CRIT).ok).toBe(false);
  });

  it("reports ok:true for a well-formed reply that simply found nothing", () => {
    const text = JSON.stringify({ sessions: [{ sessionId: "A", notApplicable: [] }], results: [] });
    expect(validateCriterionResults(text, [A], CRIT).ok).toBe(true);
  });
});

// The roster is what makes "it applied and passed" falsifiable. Silence alone can't
// distinguish a judge that considered a criterion from one that ignored it, so the
// judge must say which sessions it answered for and which criteria didn't apply there.
describe("validateCriterionResults (applicability roster)", () => {
  const A = sess("A", 1, [0, 1, 2]);
  const B = sess("B", 2, [0]);

  it("records which sessions were answered for and which criteria did not apply", () => {
    const text = JSON.stringify({
      sessions: [{ sessionId: "A", notApplicable: ["c1"] }, { sessionId: "B", notApplicable: [] }],
      results: [],
    });
    const r = validateCriterionResults(text, [A, B], CRIT);
    expect([...r.rostered].sort()).toEqual(["A", "B"]);
    expect([...(r.notApplicable.get("c1") ?? [])]).toEqual(["A"]);
  });

  it("drops a roster entry naming a session we never sent", () => {
    const text = JSON.stringify({ sessions: [{ sessionId: "GHOST", notApplicable: ["c1"] }], results: [] });
    const r = validateCriterionResults(text, [A], CRIT);
    expect([...r.rostered]).toEqual([]);
    expect(r.notApplicable.get("c1")).toBeUndefined();
  });

  // count is total findings while the denominator counts sessions, so a repeated row
  // would let a criterion report more fires than the sessions it could fire in.
  it("dedupes repeated rows for one (session, criterion), unioning the evidence", () => {
    const text = JSON.stringify({ results: [
      { sessionId: "A", criterionId: "c1", fired: true, msgIndices: [0] },
      { sessionId: "A", criterionId: "c1", fired: true, msgIndices: [2] },
    ] });
    const { findings } = validateCriterionResults(text, [A], CRIT);
    expect(findings).toHaveLength(1);
    expect(findings[0].evidence.msgIndices).toEqual([0, 2]);
  });

  // A fire IS an answer about that session, so it belongs in the denominator it is
  // reported against. Otherwise "2 in 2 of 9 applicable" can count fires from
  // sessions that are not among the 9.
  it("rosters a session the judge only mentioned via a fired row", () => {
    const text = JSON.stringify({
      sessions: [{ sessionId: "B", notApplicable: [] }],
      results: [{ sessionId: "A", criterionId: "c1", fired: true, msgIndices: [1] }],
    });
    const r = validateCriterionResults(text, [A, B], CRIT);
    expect(r.findings).toHaveLength(1);
    expect([...r.rostered].sort()).toEqual(["A", "B"]);
  });

  // A criterion that fired is self-evidently applicable; the finding wins.
  it("discards a not-applicable claim for a criterion that also fired", () => {
    const text = JSON.stringify({
      sessions: [{ sessionId: "A", notApplicable: ["c1"] }],
      results: [{ sessionId: "A", criterionId: "c1", fired: true, msgIndices: [1] }],
    });
    const r = validateCriterionResults(text, [A], CRIT);
    expect(r.findings).toHaveLength(1);
    expect(r.notApplicable.get("c1")?.has("A") ?? false).toBe(false);
  });
});

describe("judgeCriteria", () => {
  const SIG = signalOf([sess("A", 1, [0, 1]), sess("B", 2, [0])]);

  it("short-circuits without invoking the agent when there are no criteria", async () => {
    const { findings, degraded } = await judgeCriteria(SIG, [], { connectFn: async () => { throw new Error("must not connect"); } });
    expect(findings).toEqual([]);
    expect(degraded).toBe(false);
  });

  it("short-circuits when no session has steps", async () => {
    const empty = signalOf([{ sessionId: "A", transcript: "A.jsonl", atMs: 1, steps: [] }]);
    const { findings, degraded } = await judgeCriteria(empty, CRIT, { connectFn: async () => { throw new Error("must not connect"); } });
    expect(findings).toEqual([]);
    expect(degraded).toBe(false);
  });

  it("returns validated findings from the agent (degraded:false)", async () => {
    const canned = JSON.stringify({
      sessions: [{ sessionId: "A", notApplicable: [] }, { sessionId: "B", notApplicable: [] }],
      results: [{ sessionId: "A", criterionId: "c1", fired: true, msgIndices: [1] }],
    });
    const { findings, degraded } = await judgeCriteria(SIG, CRIT, { connectFn: fakeConnect(canned) });
    expect(degraded).toBe(false);
    expect(findings.map((f) => f.sessionId)).toEqual(["A"]);
    expect(findings[0].evidence.msgIndices).toEqual([1]);
  });

  it("degrades (findings skipped, never faked) on agent error", async () => {
    const { findings, degraded } = await judgeCriteria(SIG, CRIT, { connectFn: async () => { throw new Error("no binary"); } });
    expect(findings).toEqual([]);   // no cheap heuristic — skip, don't fabricate
    expect(degraded).toBe(true);
  });
});

describe("judgeCriteria applicability", () => {
  const roster = (...ids: [string, string[]][]) =>
    JSON.stringify({ sessions: ids.map(([sessionId, notApplicable]) => ({ sessionId, notApplicable })), results: [] });

  it("counts a rostered session as applicable unless the judge said it did not apply", async () => {
    const sig = signalOf([sess("A", 1, [0, 1]), sess("B", 2, [0])]);
    const { applicability } = await judgeCriteria(sig, CRIT, { connectFn: fakeConnect(roster(["A", ["c1"]], ["B", []])) });
    expect(applicability.get("c1")).toEqual({ judged: 2, applicable: 1 });
  });

  // Silence about a whole session is not a pass — it is an unanswered question.
  it("excludes a session the judge never rostered from both counts", async () => {
    const sig = signalOf([sess("A", 1, [0, 1]), sess("B", 2, [0])]);
    const { applicability } = await judgeCriteria(sig, CRIT, { connectFn: fakeConnect(roster(["A", []])) });
    expect(applicability.get("c1")).toEqual({ judged: 1, applicable: 1 });
  });

  // The judge only ever saw the first 80 steps, so it cannot vouch for the rest.
  it("excludes a step-truncated session from the denominator and reports it in coverage", async () => {
    const long = sess("L", 3, Array.from({ length: 100 }, (_, i) => i));
    const sig = signalOf([long, sess("A", 1, [0])]);
    const { applicability, coverage } = await judgeCriteria(sig, CRIT, { connectFn: fakeConnect(roster(["L", []], ["A", []])) });
    expect(coverage.truncated).toBe(1);
    expect(applicability.get("c1")).toEqual({ judged: 1, applicable: 1 });
  });

  it("counts nothing from a chunk whose reply could not be read", async () => {
    const sig = signalOf([sess("A", 1, [0, 1])]);
    const { applicability, degraded } = await judgeCriteria(sig, CRIT, { connectFn: fakeConnect("sorry, I cannot") });
    expect(degraded).toBe(true);
    expect(applicability.get("c1")).toBeUndefined();
  });
});
