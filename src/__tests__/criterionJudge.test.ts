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
    const f = validateCriterionResults(text, [A], CRIT);
    expect(f).toHaveLength(1);
    expect(f[0].evidence.msgIndices).toEqual([1, 2]);   // 99 dropped
    expect(f[0].detectorId).toBe("c1");
    expect(f[0].severity).toBe("warn");
    expect(f[0].detail).not.toContain("cmd");           // coords-only detail, never step args
  });

  it("keeps a finding with empty evidence when ALL cited indices are hallucinated (detail-only)", () => {
    const text = JSON.stringify({ results: [{ sessionId: "A", criterionId: "c1", fired: true, msgIndices: [42, 43] }] });
    const f = validateCriterionResults(text, [A], CRIT);
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
    expect(validateCriterionResults(text, [A], CRIT)).toEqual([]);
  });

  it("returns [] on non-JSON / malformed output", () => {
    expect(validateCriterionResults("not json", [A], CRIT)).toEqual([]);
    expect(validateCriterionResults(JSON.stringify({ nope: 1 }), [A], CRIT)).toEqual([]);
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
    const canned = JSON.stringify({ results: [{ sessionId: "A", criterionId: "c1", fired: true, msgIndices: [1] }] });
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
