import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanArtifactUsage } from "../optimizeScan.js";
import type { ConfigInventory } from "../types.js";

let home: string, claudeDir: string;

function inv(): ConfigInventory {
  return {
    skills: [
      { type: "skill", name: "qa", description: "d", source: "standalone", content: "x" },
      { type: "skill", name: "never-used", description: "d", source: "standalone", content: "x" },
    ],
    mcpServers: [{ type: "mcp_server", name: "context7", transport: "stdio", config: {}, source: "user" }],
    instructions: [],
    hooks: [],
  };
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "optimize-"));
  claudeDir = join(home, ".claude");
  const proj = join(claudeDir, "projects", "proj-a");
  mkdirSync(proj, { recursive: true });
  // A session that invokes Skill(qa) once and an mcp__context7__ tool once.
  writeFileSync(join(proj, "s1.jsonl"), [
    JSON.stringify({ type: "user", sessionId: "s1", cwd: "/work/app", timestamp: "2026-06-28T10:00:00.000Z", message: { role: "user" } }),
    JSON.stringify({ type: "assistant", sessionId: "s1", cwd: "/work/app", timestamp: "2026-06-28T10:00:05.000Z",
      message: { role: "assistant", model: "claude-opus-4-8", content: [
        { type: "tool_use", name: "Skill", input: { skill: "qa" } },
        { type: "tool_use", name: "mcp__context7__query-docs", input: {} },
      ] } }),
  ].join("\n") + "\n");
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("scanArtifactUsage", () => {
  it("counts used skills/mcp and emits unused ones with invocations 0", () => {
    const m = scanArtifactUsage(inv(), claudeDir);
    expect(m.get("skill:qa")?.invocations).toBe(1);
    expect(m.get("skill:qa")?.lastUsedMs).toBeGreaterThan(0);
    expect(m.get("mcp_server:context7")?.invocations).toBe(1);
    expect(m.get("skill:never-used")?.invocations).toBe(0);
    expect(m.get("skill:never-used")?.lastUsedMs).toBeNull();
  });

  it("returns an all-zero map when there are no transcripts", () => {
    const empty = join(home, "empty-claude");
    const m = scanArtifactUsage(inv(), empty);
    expect(m.get("skill:qa")?.invocations).toBe(0);
  });
});
