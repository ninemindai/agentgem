// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { distillToken, writeDistillCache, claudeTranscriptsForCwd } from "@agentgem/insight";
import { computeDistill } from "../distillCore.js";

let home: string | undefined;
const orig = process.env.AGENTGEM_HOME;
afterEach(() => { if (home) rmSync(home, { recursive: true, force: true }); home = undefined; if (orig === undefined) delete process.env.AGENTGEM_HOME; else process.env.AGENTGEM_HOME = orig; });

function seedTranscript(): string {
  home = mkdtempSync(join(tmpdir(), "dcore-")); process.env.AGENTGEM_HOME = home;
  const claudeDir = join(home, ".claude");
  const projDir = join(claudeDir, "projects", "-proj");
  mkdirSync(projDir, { recursive: true });
  writeFileSync(join(projDir, "s.jsonl"), JSON.stringify({ cwd: "/proj" }) + "\n");
  return claudeDir;
}

describe("computeDistill", () => {
  it("returns the cached payload without running the agents when the token matches", async () => {
    const claudeDir = seedTranscript();
    const token = distillToken(claudeTranscriptsForCwd(claudeDir, "/proj"));
    writeDistillCache("/proj", token, { skills: [], lessons: [], degraded: false }, 999);
    const r = await computeDistill("/proj", { dir: claudeDir });
    expect(r.cached).toBe(true);
    expect(r.updatedAt).toBe(999);
  });

  it("fresh non-degraded compute writes cache (second call hits); degraded does not", async () => {
    const claudeDir = seedTranscript();
    const okFakes = { distillWf: async () => ({ distilled: [], degraded: false }), distillLessons: async () => ({ lessons: [], degraded: false }) };
    const r1 = await computeDistill("/proj", { dir: claudeDir, now: () => 111, ...okFakes });
    expect(r1.cached).toBe(false); expect(r1.updatedAt).toBe(111);
    const r2 = await computeDistill("/proj", { dir: claudeDir });
    expect(r2.cached).toBe(true); expect(r2.updatedAt).toBe(111);

    const claudeDir2 = seedTranscript();
    const badFakes = { distillWf: async () => ({ distilled: [], degraded: true }), distillLessons: async () => ({ lessons: [], degraded: false }) };
    const d1 = await computeDistill("/proj", { dir: claudeDir2, ...badFakes });
    expect(d1.cached).toBe(false); expect(d1.updatedAt).toBeNull();
    const d2 = await computeDistill("/proj", { dir: claudeDir2, ...badFakes });
    expect(d2.cached).toBe(false);   // degraded was not cached
  });
});
