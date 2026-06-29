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
  it("flags a never-used standalone skill as prunable with a folder-removal change hint", () => {
    const c = inv({ skills: [{ type: "skill", name: "pdf-tools", description: "work with pdfs", source: "standalone", content: "x" }] });
    const p = buildOptimizePayload(c, usage([]), "30d", NOW);
    expect(p.artifacts).toHaveLength(1);
    const a = p.artifacts[0];
    expect(a).toMatchObject({ name: "pdf-tools", type: "skill", source: "standalone", uses: 0, lastUsedMs: null, prune: true });
    expect(a.contextTokens).toBe(estTokens("pdf-tools\nwork with pdfs"));
    expect(a.change).toEqual({ file: "~/.claude/skills/pdf-tools", key: "remove or move this folder (no in-place disable flag exists)" });
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
    expect(mcp.change).toEqual({ file: "settings.json / ~/.claude.json", key: 'remove mcpServers.coingecko (or add "coingecko" to disabledMcpjsonServers if defined via .mcp.json)' });
  });

  it("maps a codex skill to a filesystem hint and a codex MCP to a config.toml hint", () => {
    const c = inv({
      skills: [{ type: "skill", name: "my-skill", description: "d", source: "codex", content: "x" }],
      mcpServers: [{ type: "mcp_server", name: "my-mcp", transport: "stdio", config: { command: "x" }, source: "codex" }],
    });
    const p = buildOptimizePayload(c, usage([]), "all", NOW);
    const skill = p.artifacts.find((a) => a.type === "skill" && a.name === "my-skill")!;
    const mcp = p.artifacts.find((a) => a.type === "mcp" && a.name === "my-mcp")!;
    expect(skill.change).toEqual({ file: "~/.codex/skills/my-skill", key: "remove or move this folder (no in-place disable flag exists)" });
    expect(mcp.change).toEqual({ file: "~/.codex/config.toml", key: "set enabled = false for my-mcp" });
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

  it("flags duplicate-lines only when a SINGLE line repeats >= DUP_LINE_MIN times, not from summed duplicates", () => {
    // 4 distinct lines × 2 occurrences = 8 total repeated appearances, but no single line hits 5
    // Old summing logic: dupTotal = 2+2+2+2 = 8 >= 5 → wrongly fires
    // Correct logic: no single line has count >= 5 → must NOT fire
    const fourLinesEachTwice = ["alpha", "beta", "gamma", "delta"]
      .flatMap((l) => [l, l])
      .join("\n");
    const cNoFlag = inv({ instructions: [{ type: "instructions", name: "CLAUDE.md", content: fourLinesEachTwice }] });
    const insNoFlag = buildOptimizePayload(cNoFlag, usage([]), "all", NOW).instructions[0];
    expect(insNoFlag.flags).not.toContain("duplicate-lines");

    // One line repeated 5 times → MUST fire
    const oneLineFiveTimes = "repeat this line\n".repeat(5).trim();
    const cFlag = inv({ instructions: [{ type: "instructions", name: "CLAUDE.md", content: oneLineFiveTimes }] });
    const insFlag = buildOptimizePayload(cFlag, usage([]), "all", NOW).instructions[0];
    expect(insFlag.flags).toContain("duplicate-lines");
  });

  it("v1 global-only: ignores inv.projects; returns only global instructions, sorted by contextTokens desc", () => {
    // inv.projects is populated but must be silently ignored in v1
    const c = inv({
      instructions: [
        { type: "instructions", name: "AGENTS.md", content: "x".repeat(8000) },
        { type: "instructions", name: "CLAUDE.md", content: "short" },
      ],
      projects: [{ root: "/p", name: "p", skills: [], mcpServers: [], hooks: [],
        instructions: [{ type: "instructions", name: "p/CLAUDE.md", content: "x".repeat(12000) }] }],
    });
    const result = buildOptimizePayload(c, usage([]), "all", NOW).instructions;
    const names = result.map((i) => i.name);
    // only global instructions should appear
    expect(names).toContain("AGENTS.md");
    expect(names).toContain("CLAUDE.md");
    // per-project instruction must NOT appear (inv.projects is ignored)
    expect(names).not.toContain("p/CLAUDE.md");
    // global sort order: bigger one first
    expect(names[0]).toBe("AGENTS.md");
  });
});
