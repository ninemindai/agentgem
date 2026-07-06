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

  it("threads timeoutMs to both distill agents so the interactive path can cap the wait", async () => {
    const claudeDir = seedTranscript();
    let wfTimeout: number | undefined = -1;
    let lsTimeout: number | undefined = -1;
    const distillWf = async (_s: unknown, _i: unknown, o?: { timeoutMs?: number }) => { wfTimeout = o?.timeoutMs; return { distilled: [], degraded: false }; };
    const distillLessons = async (_s: unknown, _i: unknown, o?: { timeoutMs?: number }) => { lsTimeout = o?.timeoutMs; return { lessons: [], degraded: false }; };
    await computeDistill("/proj", { dir: claudeDir, timeoutMs: 15_000, distillWf: distillWf as never, distillLessons: distillLessons as never });
    expect(wfTimeout).toBe(15_000);
    expect(lsTimeout).toBe(15_000);
  });

  it("excludes the pipeline's own distilled drafts from the distill inventory (breaks the self-poison loop)", async () => {
    const claudeDir = seedTranscript();
    // A prior (degraded) run persisted a heuristic skeleton as a draft under
    // ~/.agentgem/distilled — exactly what poisons the next distill's dedup.
    const draftDir = join(home!, ".agentgem", "distilled", "prior-skeleton");
    mkdirSync(draftDir, { recursive: true });
    writeFileSync(join(draftDir, "SKILL.md"), "---\nname: prior-skeleton\ndescription: x\n---\nbody");

    let seenGlobalSkills: string[] = [];
    const distillWf = async (_s: unknown, inv: { global?: { skills: { name: string }[] } }) => {
      seenGlobalSkills = (inv.global?.skills ?? []).map((s) => s.name);
      return { distilled: [], degraded: false };
    };
    const distillLessons = async () => ({ lessons: [], degraded: false });
    await computeDistill("/proj", { dir: claudeDir, distillWf: distillWf as never, distillLessons: distillLessons as never });

    // The distill must NOT see its own prior draft as an "installed skill" — otherwise
    // it dedups every candidate as "already covered", emits nothing, and degrades forever.
    expect(seenGlobalSkills).not.toContain("prior-skeleton");
  });

  it("cacheOnly: hit returns the cached payload; miss returns empty and NEVER computes", async () => {
    const claudeDir = seedTranscript();
    const token = distillToken(claudeTranscriptsForCwd(claudeDir, "/proj"));
    const boom = (async () => { throw new Error("cacheOnly must not compute"); });

    // Miss: no cache entry → empty, not cached, and the (throwing) distill fakes are never called.
    const miss = await computeDistill("/proj", { dir: claudeDir, cacheOnly: true, distillWf: boom as never, distillLessons: boom as never });
    expect(miss.cached).toBe(false);
    expect(miss.payload).toEqual({ skills: [], lessons: [], degraded: false });

    // Hit: seed the cache → cacheOnly serves it.
    writeDistillCache("/proj", token, { skills: [], lessons: [], degraded: false }, 555);
    const hit = await computeDistill("/proj", { dir: claudeDir, cacheOnly: true });
    expect(hit.cached).toBe(true);
    expect(hit.updatedAt).toBe(555);
  });
});
