import { describe, it, expect } from "vitest";
import { aggregateObserve, type SessionStat } from "../observeAggregate.js";

const base: SessionStat = {
  agent: "claude", sessionId: "s", project: "p", model: "m", gitBranch: null,
  startMs: 1000, endMs: 2000, msgs: 5, tokensIn: 10, tokensOut: 5, tokensCache: 2,
};

describe("aggregateObserve — usage by artifact", () => {
  it("sums tool / skill / subagent counts across the filtered sessions, desc by count", () => {
    const stats: SessionStat[] = [
      { ...base, sessionId: "s1", tools: { Read: 3, Edit: 1, Task: 1 }, subagents: { Explore: 1 } },
      { ...base, sessionId: "s2", tools: { Read: 2, Bash: 4 }, skills: { brainstorming: 1 } },
    ];
    const p = aggregateObserve(stats, "all", 3000);
    expect(p.byTool).toEqual([
      { name: "Read", count: 5 },
      { name: "Bash", count: 4 },
      { name: "Edit", count: 1 },
      { name: "Task", count: 1 },
    ]);
    expect(p.bySkill).toEqual([{ name: "brainstorming", count: 1 }]);
    expect(p.bySubagent).toEqual([{ name: "Explore", count: 1 }]);
  });

  it("returns empty arrays when sessions carry no tool data (back-compat)", () => {
    const p = aggregateObserve([base], "all", 3000);
    expect(p.byTool).toEqual([]);
    expect(p.bySkill).toEqual([]);
    expect(p.bySubagent).toEqual([]);
  });

  it("respects the range/attribute filters when aggregating usage", () => {
    const stats: SessionStat[] = [
      { ...base, sessionId: "in", agent: "claude", tools: { Read: 2 } },
      { ...base, sessionId: "out", agent: "codex", tools: { Read: 99 } },
    ];
    const p = aggregateObserve(stats, "all", 3000, { agent: "claude" });
    expect(p.byTool).toEqual([{ name: "Read", count: 2 }]);
  });

  it("builds a per-day usage series (top artifacts) keyed by UTC date", () => {
    const day1 = Date.UTC(2026, 6, 1), day2 = Date.UTC(2026, 6, 2);
    const stats: SessionStat[] = [
      { ...base, sessionId: "a", startMs: day1, endMs: day1 + 1000, skills: { brainstorming: 2, run: 1 } },
      { ...base, sessionId: "b", startMs: day1, endMs: day1 + 2000, skills: { brainstorming: 1 }, tools: { Bash: 3 } },
      { ...base, sessionId: "c", startMs: day2, endMs: day2 + 1000, skills: { brainstorming: 1 } },
    ];
    const p = aggregateObserve(stats, "all", day2 + 5000);
    expect(p.usageDaily.map((d) => d.date)).toEqual(["2026-07-01", "2026-07-02"]);
    expect(p.usageDaily[0].skills).toEqual({ brainstorming: 3, run: 1 }); // both sessions on day1
    expect(p.usageDaily[0].tools).toEqual({ Bash: 3 });
    expect(p.usageDaily[1].skills).toEqual({ brainstorming: 1 });
  });

  it("caps each day's series to the top-6 artifacts by total count", () => {
    const day = Date.UTC(2026, 6, 1);
    const tools: Record<string, number> = {};
    for (let i = 0; i < 9; i++) tools["t" + i] = 9 - i; // t0=9 … t8=1
    const p = aggregateObserve([{ ...base, startMs: day, endMs: day + 1, tools }], "all", day + 5);
    expect(Object.keys(p.usageDaily[0].tools)).toEqual(["t0", "t1", "t2", "t3", "t4", "t5"]);
  });
});
