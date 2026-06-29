import { describe, it, expect } from "vitest";
import { prettifyId, kindLabel, verifiedShare, barWidths, sparkPoints, filterRows } from "./data";

describe("prettifyId", () => {
  it("splits plugin skills/mcps into name + scope", () => {
    expect(prettifyId("skill:superpowers/brainstorming", "skill")).toEqual({ name: "brainstorming", scope: "superpowers" });
  });
  it("treats a package runner prefix as the scope", () => {
    expect(prettifyId("npx:@modelcontextprotocol/server-github", "mcp")).toEqual({ name: "@modelcontextprotocol/server-github", scope: "npx" });
  });
  it("passes through model/harness ids", () => {
    expect(prettifyId("claude-opus-4-8", "model")).toEqual({ name: "claude-opus-4-8" });
  });
});

describe("kindLabel", () => {
  it("maps known kinds and falls through", () => {
    expect(kindLabel("skill")).toBe("Skill");
    expect(kindLabel("widget")).toBe("widget");
  });
});

describe("verifiedShare", () => {
  it("is verified/producers clamped to [0,1], 0 when no producers", () => {
    expect(verifiedShare(10, 4)).toBeCloseTo(0.4);
    expect(verifiedShare(0, 0)).toBe(0);
  });
});

describe("barWidths", () => {
  it("normalizes against the max", () => {
    expect(barWidths([5, 10, 0])).toEqual([0.5, 1, 0]);
    expect(barWidths([])).toEqual([]);
  });
});

describe("sparkPoints", () => {
  it("maps values across width and inverts y", () => {
    expect(sparkPoints([0, 10], 100, 40)).toBe("0.0,40.0 100.0,0.0");
  });
});

describe("filterRows", () => {
  const rows = [
    { id: "skill:superpowers/brainstorming", kind: "skill", producers: 80, verifiedProducers: 40, invocations: 200, sessions: 90 },
    { id: "npx:@mcp/github", kind: "mcp", producers: 30, verifiedProducers: 9, invocations: 50, sessions: 25 },
  ];
  it("returns all rows with 1-based ranks when blank", () => {
    expect(filterRows(rows, "  ")).toEqual([{ row: rows[0], rank: 1 }, { row: rows[1], rank: 2 }]);
  });
  it("filters case-insensitively, preserving original rank", () => {
    expect(filterRows(rows, "GITHUB")).toEqual([{ row: rows[1], rank: 2 }]);
  });
});
