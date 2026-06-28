import { describe, it, expect } from "vitest";
import { prettifyId, kindLabel, verifiedShare, barWidths, sparkPoints } from "./data.js";

describe("prettifyId", () => {
  it("splits plugin skills/mcps into name + scope", () => {
    expect(prettifyId("skill:superpowers/brainstorming", "skill")).toEqual({ name: "brainstorming", scope: "superpowers" });
    expect(prettifyId("mcp:plug/server", "mcp")).toEqual({ name: "server", scope: "plug" });
  });
  it("treats a package runner prefix as the scope", () => {
    expect(prettifyId("npx:@modelcontextprotocol/server-github", "mcp")).toEqual({ name: "@modelcontextprotocol/server-github", scope: "npx" });
  });
  it("labels url mcps", () => {
    expect(prettifyId("url:api.github.com", "mcp")).toEqual({ name: "api.github.com", scope: "url" });
  });
  it("passes through models/harness/registry ids with no prefix", () => {
    expect(prettifyId("claude-opus-4-8", "model")).toEqual({ name: "claude-opus-4-8" });
    expect(prettifyId("claude-code", "harness")).toEqual({ name: "claude-code" });
  });
});

describe("kindLabel", () => {
  it("maps known kinds and falls through", () => {
    expect(kindLabel("skill")).toBe("Skill");
    expect(kindLabel("mcp")).toBe("MCP");
    expect(kindLabel("widget")).toBe("widget");
  });
});

describe("verifiedShare", () => {
  it("is verified/producers clamped to [0,1], 0 when no producers", () => {
    expect(verifiedShare(10, 4)).toBeCloseTo(0.4);
    expect(verifiedShare(0, 0)).toBe(0);
    expect(verifiedShare(3, 5)).toBe(1); // clamp (shouldn't exceed, but be safe)
  });
});

describe("barWidths", () => {
  it("normalizes against the max (max => 1)", () => {
    expect(barWidths([5, 10, 0])).toEqual([0.5, 1, 0]);
    expect(barWidths([])).toEqual([]);
  });
});

describe("sparkPoints", () => {
  it("returns '' for empty and a flat baseline for a single point", () => {
    expect(sparkPoints([], 100, 40)).toBe("");
    expect(sparkPoints([7], 100, 40)).toBe("0,0 100,0"); // single value pins to top (its own max)
  });
  it("maps values to x across width and inverts y (taller = higher value)", () => {
    expect(sparkPoints([0, 10], 100, 40)).toBe("0.0,40.0 100.0,0.0");
  });
  it("honors an explicit shared max (for overlaying verified on producers)", () => {
    expect(sparkPoints([5], 100, 40, 10)).toBe("0,20 100,20");
  });
});
