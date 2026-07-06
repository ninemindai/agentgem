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
});
