// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { judgeCriteria, DEFAULT_MAX_CRITERION_SESSIONS } from "@agentgem/insight";
import type { WorkflowSignal, SessionSequence, AcpConnectFn, LlmCriterion } from "@agentgem/insight";

const CRITERIA: LlmCriterion[] = [
  { id: "c1", title: "C1", question: "did they?", advice: "do it", severity: "warn" },
];

function sess(id: string, atMs: number): SessionSequence {
  return { steps: [{ verb: "Bash:git status", arg: "", tool: "Bash", msgIndex: 0 }], sessionId: id, transcript: `${id}.jsonl`, atMs } as SessionSequence;
}

function signalWith(sessions: SessionSequence[]): WorkflowSignal {
  return {
    root: "/r", flavor: "claude",
    sessions: { scanned: sessions.length, firstMs: 0, lastMs: 0, spanDays: 0 },
    models: [], artifacts: [], unresolved: [], coOccurrence: [], shapes: [], notes: [],
    sequences: { root: "/r", sessions },
  } as WorkflowSignal;
}

const okConnect: AcpConnectFn = async () => ({
  ctx: { async open() { return { async setMode() {}, async promptText() { return JSON.stringify({ results: [] }); }, dispose() {} }; } },
  close() {},
});

describe("judgeCriteria coverage", () => {
  it("reports sampling when the cap drops eligible sessions", async () => {
    const sessions = [1, 2, 3, 4, 5].map((n) => sess(`s${n}`, n * 100));
    const { coverage } = await judgeCriteria(signalWith(sessions), CRITERIA, { maxSessions: 2, connectFn: okConnect });
    expect(coverage).toEqual({ eligible: 5, judged: 2, sampled: true, truncated: 0 });
  });

  it("reports full coverage when every eligible session was judged", async () => {
    const { coverage } = await judgeCriteria(signalWith([sess("a", 1)]), CRITERIA, { connectFn: okConnect });
    expect(coverage).toEqual({ eligible: 1, judged: 1, sampled: false, truncated: 0 });
  });

  it("reports zero coverage on the no-criteria short-circuit (agent never invoked)", async () => {
    const { coverage } = await judgeCriteria(signalWith([sess("a", 1)]), [], {
      connectFn: async () => { throw new Error("should not be called"); },
    });
    expect(coverage).toEqual({ eligible: 0, judged: 0, sampled: false, truncated: 0 });
  });

  it("defaults the cap to DEFAULT_MAX_CRITERION_SESSIONS", async () => {
    const sessions = Array.from({ length: DEFAULT_MAX_CRITERION_SESSIONS + 5 }, (_, i) => sess(`s${i}`, i * 100));
    const { coverage } = await judgeCriteria(signalWith(sessions), CRITERIA, { connectFn: okConnect });
    expect(coverage.judged).toBe(DEFAULT_MAX_CRITERION_SESSIONS);
    expect(coverage.sampled).toBe(true);
  });
});
