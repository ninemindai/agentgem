// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanArtifactUsage } from "../optimizeScan.js";
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
