// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WARMABLES } from "../registry.js";
import { distillToken, writeDistillCache, claudeTranscriptsForCwd } from "@agentgem/insight";

const orig = process.env.AGENTGEM_HOME;
afterEach(() => { if (orig === undefined) delete process.env.AGENTGEM_HOME; else process.env.AGENTGEM_HOME = orig; });

function usage() { return WARMABLES.find((w) => w.id === "usage")!; }
function scorecard() { return WARMABLES.find((w) => w.id === "scorecard")!; }

describe("usage warmable", () => {
  it("warms on first call, then reports a hit on the second (same sessions)", async () => {
    const home = mkdtempSync(join(tmpdir(), "reg-"));
    process.env.AGENTGEM_HOME = home;
    const claudeDir = join(home, ".claude", "projects", "-proj");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "s.jsonl"), JSON.stringify({ cwd: "/proj" }) + "\n");
    const dir = join(home, ".claude");

    try {
      expect(await usage().warm(null, { dir })).toBe("warmed");
      expect(await usage().warm(null, { dir })).toBe("hit");
      expect(await usage().warm(null, { dir, force: true })).toBe("warmed");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("scorecard warmable", () => {
  it("warms on first call, hits on second, force re-warms", async () => {
    const home = mkdtempSync(join(tmpdir(), "reg-sc-"));
    process.env.AGENTGEM_HOME = home;
    const claudeDir = join(home, ".claude", "projects", "-proj");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "s.jsonl"), JSON.stringify({ cwd: "/proj" }) + "\n");
    const dir = join(home, ".claude");

    try {
      expect(await scorecard().warm(null, { dir })).toBe("warmed");
      expect(await scorecard().warm(null, { dir })).toBe("hit");
      expect(await scorecard().warm(null, { dir, force: true })).toBe("warmed");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("distill warmable", () => {
  it("distill warmable: hit on seeded cache, force recomputes", async () => {
    const home = mkdtempSync(join(tmpdir(), "regd-"));
    const prev = process.env.AGENTGEM_HOME; process.env.AGENTGEM_HOME = home;
    try {
      const claudeDir = join(home, ".claude");
      const projDir = join(claudeDir, "projects", "-proj");
      mkdirSync(projDir, { recursive: true });
      writeFileSync(join(projDir, "s.jsonl"), JSON.stringify({ cwd: "/proj" }) + "\n");
      const token = distillToken(claudeTranscriptsForCwd(claudeDir, "/proj"));
      writeDistillCache("/proj", token, { skills: [], lessons: [], degraded: false }, 1);
      const d = WARMABLES.find((w) => w.id === "distill")!;
      expect(d.cost).toBe("llm"); expect(d.scope).toBe("per-root");
      expect(await d.warm("/proj", { dir: claudeDir })).toBe("hit");
    } finally { if (prev === undefined) delete process.env.AGENTGEM_HOME; else process.env.AGENTGEM_HOME = prev; rmSync(home, { recursive: true, force: true }); }
  });
});
