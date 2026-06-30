// src/gem/__tests__/judgeSession.test.ts
import { describe, it, expect } from "vitest";
import { judgeSessions } from "@agentgem/insight";
import type { WorkflowSignal, SessionSequence, AcpConnectFn } from "@agentgem/insight";

function sess(id: string, task: string | null): SessionSequence {
  const base: SessionSequence = { steps: [], sessionId: id, transcript: `${id}.jsonl`, atMs: 100 };
  return task === null ? base : { ...base, missionHint: { task, outcome: "done" } };
}

function signalWith(sessions: SessionSequence[]): WorkflowSignal {
  return {
    root: "/r", flavor: "claude",
    sessions: { scanned: sessions.length, firstMs: 0, lastMs: 0, spanDays: 0 },
    models: [], artifacts: [], unresolved: [], coOccurrence: [], shapes: [], notes: [],
    sequences: { root: "/r", sessions },
  };
}

// Fake agent: asserts the session was put in plan mode (read-only) before prompting.
function fakeConnect(canned: string): AcpConnectFn {
  return async () => ({
    ctx: {
      async open(_cwd: string) {
        let mode = "default";
        return {
          async setMode(m: string) { mode = m; },
          async promptText(_t: string) {
            if (mode !== "plan") throw new Error(`expected plan mode, got ${mode}`);
            return canned;
          },
          dispose() {},
        };
      },
    },
    close() {},
  });
}

const SIG = signalWith([sess("a", "Ship the auth flow"), sess("b", "Fix the DNS outage")]);

describe("judgeSessions", () => {
  it("judges missioned sessions from the agent response (degraded:false)", async () => {
    const canned = JSON.stringify({ facets: [
      { sessionId: "a", underlying_goal: "Ship GitHub device-flow auth", outcome: "mostly_achieved", friction_detail: "", brief_summary: "Merged auth binding." },
      { sessionId: "b", underlying_goal: "Restore agentgem.ai DNS", outcome: "not_achieved", friction_detail: "Negative-cache delay", brief_summary: "Root-caused but not fully fixed." },
    ] });
    const { facets, degraded } = await judgeSessions(SIG, { connectFn: fakeConnect(canned) });
    expect(degraded).toBe(false);
    expect(facets).toHaveLength(2);
    expect(facets.every((f) => f.origin === "llm")).toBe(true);
    expect(facets.find((f) => f.sessionId === "b")!.outcome).toBe("not_achieved");
  });

  it("short-circuits to empty when no session carries a mission (agent never invoked)", async () => {
    const noMission = signalWith([sess("a", null), sess("b", null)]);
    const { facets, degraded } = await judgeSessions(noMission, {
      connectFn: async () => { throw new Error("should not be called"); },
    });
    expect(facets).toEqual([]);
    expect(degraded).toBe(false);
  });

  it("degrades to heuristic facets (never throws) on agent error", async () => {
    const { facets, degraded } = await judgeSessions(SIG, {
      connectFn: async () => { throw new Error("no binary"); },
    });
    expect(degraded).toBe(true);
    expect(facets).toHaveLength(2);
    expect(facets.every((f) => f.origin === "heuristic")).toBe(true);
  });

  it("falls back to heuristic facets (degraded:false) when the agent returns junk", async () => {
    const { facets, degraded } = await judgeSessions(SIG, { connectFn: fakeConnect("not json") });
    expect(degraded).toBe(false); // the call succeeded; validation just couldn't use the output
    expect(facets).toHaveLength(2);
    expect(facets.every((f) => f.origin === "heuristic")).toBe(true);
  });
});
