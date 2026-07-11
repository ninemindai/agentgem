// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanArtifactUsage, optimizeUsageMap, type IndexedUsageArtifact } from "../optimizeScan.js";
import type { ConfigInventory } from "@agentgem/model";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "optscan-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

// Minimal transcript: two sessions in different cwds, each invoking a skill.
// Shape mirrors a real ~/.claude/projects/*/*.jsonl record: top-level `cwd`,
// and the tool_use block lives under message.role === "assistant" with
// input.skill (not input.command) — that's what scanWorkflow's parser matches.
function writeSession(folder: string, cwd: string, skill: string) {
  const d = join(dir, "projects", folder);
  mkdirSync(d, { recursive: true });
  const lines = [
    JSON.stringify({ type: "summary", cwd }),
    JSON.stringify({ type: "assistant", cwd, message: { role: "assistant", content: [{ type: "tool_use", name: "Skill", input: { skill } }] } }),
  ].join("\n");
  writeFileSync(join(d, "s.jsonl"), lines + "\n");
}

const inv: ConfigInventory = {
  skills: [{ type: "skill", name: "alpha", source: "project", description: "" } as any],
  mcpServers: [], instructions: [], hooks: [], subagents: [],
};

describe("scanArtifactUsage cwd filter", () => {
  it("counts only the chosen project's sessions when cwd is passed", () => {
    writeSession("a", "/repo/a", "alpha");
    writeSession("b", "/repo/b", "alpha");
    const all = scanArtifactUsage(inv, dir);
    const scoped = scanArtifactUsage(inv, dir, "/repo/a");
    expect(all.get("skill:alpha")?.invocations).toBe(2);
    expect(scoped.get("skill:alpha")?.invocations).toBe(1);
  });
});

describe("optimizeUsageMap (indexed global-usage adapter)", () => {
  const rows: IndexedUsageArtifact[] = [
    { type: "skill", name: "alpha", root: null, invocations: 3, sessionsUsedIn: 2, lastUsedMs: 111 },
    { type: "mcp_server", name: "ctx7", root: null, invocations: 1, sessionsUsedIn: 1, lastUsedMs: 222 },
    { type: "hook", name: "some-hook", root: null, invocations: 9, sessionsUsedIn: 4, lastUsedMs: 333 },
  ];

  it("keys skill/mcp rows by `${type}:${name}` and preserves usage fields", () => {
    const map = optimizeUsageMap(rows);
    expect(map.get("skill:alpha")).toMatchObject({ type: "skill", name: "alpha", invocations: 3, lastUsedMs: 111, confidence: "high" });
    expect(map.get("mcp_server:ctx7")).toMatchObject({ type: "mcp_server", name: "ctx7", invocations: 1, lastUsedMs: 222 });
  });

  it("drops non skill/mcp artifacts (hooks are not part of the Optimize view)", () => {
    const map = optimizeUsageMap(rows);
    expect(map.has("hook:some-hook")).toBe(false);
    expect(map.size).toBe(2);
  });
});
