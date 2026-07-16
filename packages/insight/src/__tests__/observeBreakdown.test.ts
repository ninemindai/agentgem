import { describe, it, expect } from "vitest";
import { aggregateObserve, type SessionStat } from "../observeAggregate.js";

const base: SessionStat = {
  agent: "claude", sessionId: "s", project: "p", model: "m", gitBranch: null,
  startMs: 1000, endMs: 2000, msgs: 5, tokensIn: 10, tokensOut: 5, tokensCache: 2,
};

describe("aggregateObserve — token attribution (byProject / topSessions)", () => {
  it("buckets by project with null kept as null, sorted desc by tokens", () => {
    const stats: SessionStat[] = [
      { ...base, sessionId: "s1", project: "a", tokensIn: 100, tokensOut: 0, tokensCache: 0 },
      { ...base, sessionId: "s2", project: "a", tokensIn: 30, tokensOut: 10, tokensCache: 10 },
      { ...base, sessionId: "s3", project: null, tokensIn: 60, tokensOut: 0, tokensCache: 0 },
    ];
    const p = aggregateObserve(stats, "all", 3000);
    expect(p.byProject).toEqual([
      { project: "a", sessions: 2, tokens: 150, tokensIn: 130, tokensOut: 10, tokensCache: 10 },
      { project: null, sessions: 1, tokens: 60, tokensIn: 60, tokensOut: 0, tokensCache: 0 },
    ]);
  });

  it("byProject ignores the project filter but respects agent/model/minMsgs (partial-filter aggregate)", () => {
    const stats: SessionStat[] = [
      { ...base, sessionId: "s1", project: "a", agent: "claude" },
      { ...base, sessionId: "s2", project: "b", agent: "claude" },
      { ...base, sessionId: "s3", project: "b", agent: "codex" },
    ];
    const p = aggregateObserve(stats, "all", 3000, { agent: "claude", project: "a" });
    // The project filter did NOT collapse the ranking…
    expect(p.byProject.map((r) => r.project).sort()).toEqual(["a", "b"]);
    // …but the agent filter still applied (codex session excluded from project b)…
    expect(p.byProject.find((r) => r.project === "b")!.sessions).toBe(1);
    // …and the rest of the payload IS project-scoped as before.
    expect(p.pulse.sessions).toBe(1);
    expect(p.topSessions).toHaveLength(1);
    expect(p.topSessions[0].sessionId).toBe("s1");
  });

  it("ranks over the UNCAPPED set — a token whale older than the 200-session payload cap still wins", () => {
    const stats: SessionStat[] = [];
    for (let i = 0; i < 220; i++) {
      stats.push({ ...base, sessionId: `recent-${i}`, endMs: 100_000 + i, tokensIn: 1, tokensOut: 0, tokensCache: 0 });
    }
    stats.push({ ...base, sessionId: "whale", endMs: 50_000, tokensIn: 9_999, tokensOut: 0, tokensCache: 0 });
    const p = aggregateObserve(stats, "all", 300_000);
    expect(p.sessions.find((s) => s.sessionId === "whale")).toBeUndefined(); // fell off the recency cap
    expect(p.topSessions[0].sessionId).toBe("whale");                        // still ranked #1 by tokens
    expect(p.topSessions).toHaveLength(8);                                   // capped at 8
    expect(p.byProject[0].tokens).toBe(220 + 9_999);                         // sums see past the cap too
  });

  it("topSessions rows carry the token split and endMs", () => {
    const p = aggregateObserve([{ ...base, sessionId: "s1" }], "all", 3000);
    expect(p.topSessions).toEqual([
      { agent: "claude", sessionId: "s1", project: "p", model: "m", tokens: 17, tokensIn: 10, tokensOut: 5, tokensCache: 2, endMs: 2000 },
    ]);
  });

  it("returns empty arrays for an empty range", () => {
    const p = aggregateObserve([], "all", 3000);
    expect(p.byProject).toEqual([]);
    expect(p.topSessions).toEqual([]);
  });
});
