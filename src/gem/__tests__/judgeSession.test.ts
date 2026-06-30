// src/gem/__tests__/judgeSession.test.ts
import { describe, it, expect } from "vitest";
import { judgeSessions, DEFAULT_MAX_JUDGE } from "@agentgem/insight";
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

  it("caps judging to the most-recent N missioned sessions (prompt-size bound)", async () => {
    // 5 missioned sessions with ascending recency; cap to 2 → only the two newest.
    const sessions = [1, 2, 3, 4, 5].map((n) => ({
      steps: [], sessionId: `s${n}`, transcript: `s${n}.jsonl`, atMs: n * 100,
      missionHint: { task: `task ${n}`, outcome: "done" },
    }));
    const sig: WorkflowSignal = signalWith(sessions);
    // Agent errors → deterministic fallback over the CAPPED set proves the cap.
    const { facets } = await judgeSessions(sig, {
      maxSessions: 2,
      connectFn: async () => { throw new Error("boom"); },
    });
    expect(facets).toHaveLength(2);
    expect(facets.map((f) => f.sessionId).sort()).toEqual(["s4", "s5"]); // the two most recent
  });

  it("defaults the cap to DEFAULT_MAX_JUDGE", async () => {
    const sessions = Array.from({ length: DEFAULT_MAX_JUDGE + 10 }, (_, i) => ({
      steps: [], sessionId: `s${i}`, transcript: `s${i}.jsonl`, atMs: i * 100,
      missionHint: { task: `task ${i}`, outcome: "done" },
    }));
    const { facets } = await judgeSessions(signalWith(sessions), {
      connectFn: async () => { throw new Error("boom"); }, // fallback over the capped set
    });
    expect(facets).toHaveLength(DEFAULT_MAX_JUDGE); // capped below the available count
  });

  // Echo fake: returns one mostly_achieved facet per sessionId in the chunk's
  // prompt, so multi-chunk accumulation is observable. failCall throws on the Nth
  // connectFn call (one call == one chunk).
  function echoConnect(failCall = -1): AcpConnectFn {
    let call = 0;
    return async () => {
      const myCall = call++;
      return {
        ctx: {
          async open(_cwd: string) {
            let mode = "default";
            return {
              async setMode(m: string) { mode = m; },
              async promptText(prompt: string) {
                if (mode !== "plan") throw new Error("not plan");
                if (myCall === failCall) throw new Error(`chunk ${myCall} failed`);
                const ids = [...prompt.matchAll(/"sessionId":"([^"]+)"/g)].map((m) => m[1]);
                return JSON.stringify({ facets: ids.map((id) => ({ sessionId: id, underlying_goal: "g", outcome: "mostly_achieved", friction_detail: "", brief_summary: "s" })) });
              },
              dispose() {},
            };
          },
        },
        close() {},
      };
    };
  }

  function manySessions(n: number): WorkflowSignal {
    return signalWith(Array.from({ length: n }, (_, i) => ({
      steps: [], sessionId: `s${i}`, transcript: `s${i}.jsonl`, atMs: i * 100,
      missionHint: { task: `task ${i}`, outcome: "done" },
    })));
  }

  it("judges in chunks and accumulates facets across all chunks", async () => {
    const { facets, degraded } = await judgeSessions(manySessions(25), { maxSessions: 25, chunkSize: 10, connectFn: echoConnect() });
    expect(facets).toHaveLength(25);                       // 10 + 10 + 5
    expect(facets.every((f) => f.origin === "llm")).toBe(true);
    expect(degraded).toBe(false);
  });

  it("degrades only the failing chunk; other chunks still succeed", async () => {
    const { facets, degraded } = await judgeSessions(manySessions(25), { maxSessions: 25, chunkSize: 10, connectFn: echoConnect(1) }); // 2nd chunk fails
    expect(facets).toHaveLength(25);
    expect(facets.filter((f) => f.origin === "heuristic")).toHaveLength(10); // the failed chunk's sessions
    expect(facets.filter((f) => f.origin === "llm")).toHaveLength(15);       // the two good chunks
    expect(degraded).toBe(true);
  });
});
