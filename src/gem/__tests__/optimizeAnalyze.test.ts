import { describe, it, expect } from "vitest";
import { estTokens, rangeStartMs, buildOptimizePayload } from "../optimizeAnalyze.js";
import type { ConfigInventory } from "../types.js";
import type { ArtifactUsage } from "../workflowScan.js";

const NOW = Date.parse("2026-06-29T00:00:00.000Z");
const DAY = 86_400_000;

function inv(over: Partial<ConfigInventory> = {}): ConfigInventory {
  return { skills: [], mcpServers: [], instructions: [], hooks: [], ...over };
}
function usage(rows: Array<[string, Partial<ArtifactUsage>]>): Map<string, ArtifactUsage> {
  const m = new Map<string, ArtifactUsage>();
  for (const [key, u] of rows) {
    m.set(key, { type: "skill", name: "", root: null, invocations: 0, sessionsUsedIn: 0, lastUsedMs: null, confidence: "high", ...u });
  }
  return m;
}

describe("estTokens", () => {
  it("is ceil(chars/4)", () => {
    expect(estTokens("")).toBe(0);
    expect(estTokens("abcd")).toBe(1);
    expect(estTokens("abcde")).toBe(2);
  });
});

describe("rangeStartMs", () => {
  it("maps ranges to a start cutoff; all = 0", () => {
    expect(rangeStartMs("all", NOW)).toBe(0);
    expect(rangeStartMs("7d", NOW)).toBe(NOW - 7 * DAY);
    expect(rangeStartMs("30d", NOW)).toBe(NOW - 30 * DAY);
    expect(rangeStartMs("today", NOW)).toBe(NOW - DAY);
  });
});

describe("buildOptimizePayload — prune", () => {
  it("flags a never-used standalone skill as prunable with a skillOverrides change hint", () => {
    const c = inv({ skills: [{ type: "skill", name: "pdf-tools", description: "work with pdfs", source: "standalone", content: "x" }] });
    const p = buildOptimizePayload(c, usage([]), "30d", NOW);
    expect(p.artifacts).toHaveLength(1);
    const a = p.artifacts[0];
    expect(a).toMatchObject({ name: "pdf-tools", type: "skill", source: "standalone", uses: 0, lastUsedMs: null, prune: true });
    expect(a.contextTokens).toBe(estTokens("pdf-tools\nwork with pdfs"));
    expect(a.change).toEqual({ file: "settings.json", key: 'skillOverrides["pdf-tools"] = "off"' });
  });

  it("does NOT prune a skill used within the range, and reports its usage", () => {
    const c = inv({ skills: [{ type: "skill", name: "qa", description: "d", source: "standalone", content: "x" }] });
    const u = usage([["skill:qa", { type: "skill", name: "qa", invocations: 4, sessionsUsedIn: 2, lastUsedMs: NOW - 2 * DAY }]]);
    const a = buildOptimizePayload(c, u, "30d", NOW).artifacts[0];
    expect(a).toMatchObject({ uses: 4, prune: false });
    expect(a.lastUsedMs).toBe(NOW - 2 * DAY);
  });

  it("prunes a skill last used BEFORE the range window", () => {
    const c = inv({ skills: [{ type: "skill", name: "old", description: "d", source: "standalone", content: "x" }] });
    const u = usage([["skill:old", { name: "old", invocations: 1, sessionsUsedIn: 1, lastUsedMs: NOW - 40 * DAY }]]);
    const a = buildOptimizePayload(c, u, "30d", NOW).artifacts[0];
    expect(a.prune).toBe(true);
    expect(a.uses).toBe(1);
  });

  it("maps a plugin skill to an enabledPlugins hint and a user MCP to a mcpServers hint", () => {
    const c = inv({
      skills: [{ type: "skill", name: "review", description: "d", source: "plugin:brooks-lint", content: "x" }],
      mcpServers: [{ type: "mcp_server", name: "coingecko", transport: "stdio", config: { command: "x" }, source: "user" }],
    });
    const p = buildOptimizePayload(c, usage([]), "all", NOW);
    const skill = p.artifacts.find((a) => a.type === "skill")!;
    const mcp = p.artifacts.find((a) => a.type === "mcp")!;
    expect(skill.change).toEqual({ file: "settings.json", key: 'enabledPlugins["brooks-lint"] = false' });
    expect(mcp.change).toEqual({ file: "settings.json", key: "mcpServers.coingecko (remove, or add to deniedMcpServers)" });
  });

  it("sorts artifacts by contextTokens desc", () => {
    const c = inv({
      skills: [
        { type: "skill", name: "small", description: "x", source: "standalone", content: "x" },
        { type: "skill", name: "big", description: "x".repeat(400), source: "standalone", content: "x" },
      ],
    });
    const names = buildOptimizePayload(c, usage([]), "all", NOW).artifacts.map((a) => a.name);
    expect(names).toEqual(["big", "small"]);
  });

  it("collapses multiple unused artifacts from one plugin into a single row", () => {
    const c = inv({
      skills: [
        { type: "skill", name: "a", description: "d", source: "plugin:vercel", content: "x" },
        { type: "skill", name: "b", description: "d", source: "plugin:vercel", content: "x" },
      ],
    });
    const rows = buildOptimizePayload(c, usage([]), "all", NOW).artifacts.filter((a) => a.source === "plugin:vercel");
    expect(rows).toHaveLength(1);
  });
});

describe("buildOptimizePayload — instructions health", () => {
  it("estimates tokens, counts lines, and flags oversized + duplicate-lines", () => {
    const big = "rule\n".repeat(50) + "x".repeat(9000);
    const c = inv({ instructions: [{ type: "instructions", name: "CLAUDE.md", content: big }] });
    const ins = buildOptimizePayload(c, usage([]), "all", NOW).instructions[0];
    expect(ins.name).toBe("CLAUDE.md");
    expect(ins.contextTokens).toBe(estTokens(big));
    expect(ins.flags).toContain("oversized");
    expect(ins.flags).toContain("duplicate-lines");
  });

  it("flags very-long without oversized for many short lines", () => {
    const content = Array.from({ length: 320 }, (_, i) => `line ${i}`).join("\n");
    const c = inv({ instructions: [{ type: "instructions", name: "AGENTS.md", content }] });
    const ins = buildOptimizePayload(c, usage([]), "all", NOW).instructions[0];
    expect(ins.flags).toContain("very-long");
    expect(ins.lines).toBe(320);
  });

  it("includes per-project instructions and sorts by contextTokens desc", () => {
    const c = inv({
      instructions: [{ type: "instructions", name: "CLAUDE.md", content: "short" }],
      projects: [{ root: "/p", name: "p", skills: [], mcpServers: [], hooks: [],
        instructions: [{ type: "instructions", name: "p/CLAUDE.md", content: "x".repeat(8000) }] }],
    });
    const names = buildOptimizePayload(c, usage([]), "all", NOW).instructions.map((i) => i.name);
    expect(names[0]).toBe("p/CLAUDE.md");
    expect(names).toContain("CLAUDE.md");
  });
});
