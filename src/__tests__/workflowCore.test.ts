// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcriptToken, writeAnalysisCache, claudeTranscriptsForCwd, recommendWorkflow, distillWorkflow } from "@agentgem/insight";
import { computeWorkflowAnalysis } from "../workflowCore.js";

const orig = process.env.AGENTGEM_HOME;
let home: string | undefined;
afterEach(() => {
  if (orig === undefined) delete process.env.AGENTGEM_HOME; else process.env.AGENTGEM_HOME = orig;
  if (home) { rmSync(home, { recursive: true, force: true }); home = undefined; }
});

describe("computeWorkflowAnalysis", () => {
  it("returns the cached payload without running the agent when the token matches", async () => {
    home = mkdtempSync(join(tmpdir(), "wf-"));
    process.env.AGENTGEM_HOME = home;
    const claudeDir = join(home, ".claude");
    const projDir = join(claudeDir, "projects", "-proj");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, "s.jsonl"), JSON.stringify({ cwd: "/proj" }) + "\n");

    const token = transcriptToken(claudeTranscriptsForCwd(claudeDir, "/proj"));
    const payload = { candidates: [], gaps: [], distilled: null, reflections: [], signalSummary: { sessionsScanned: 1, spanDays: 0, notes: [] }, degraded: false };
    writeAnalysisCache("/proj", token, payload, 555);

    const res = await computeWorkflowAnalysis("/proj", { dir: claudeDir });
    expect(res.cached).toBe(true);
    expect(res.updatedAt).toBe(555);
  });

  it("fresh non-degraded compute: writes cache, second call returns hit", async () => {
    home = mkdtempSync(join(tmpdir(), "wf-nd-"));
    process.env.AGENTGEM_HOME = home;
    const claudeDir = join(home, ".claude");
    const projDir = join(claudeDir, "projects", "-proj2");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, "t.jsonl"), JSON.stringify({ cwd: "/proj2" }) + "\n");

    const fakeRecommend: typeof recommendWorkflow = async () => ({ analysis: { candidates: [], gaps: [], distilled: [], reflections: [] }, degraded: false });
    const fakeDistill: typeof distillWorkflow = async () => ({ distilled: [], degraded: false });

    const first = await computeWorkflowAnalysis("/proj2", { dir: claudeDir, recommend: fakeRecommend, distill: fakeDistill });
    expect(first.cached).toBe(false);
    expect(typeof first.updatedAt).toBe("number");

    // Second call without force — must hit the cache written by the first call.
    const second = await computeWorkflowAnalysis("/proj2", { dir: claudeDir, recommend: fakeRecommend, distill: fakeDistill });
    expect(second.cached).toBe(true);
    expect(second.updatedAt).toBe(first.updatedAt);
  });

  it("degraded via distill: does not write cache, repeated calls stay uncached", async () => {
    home = mkdtempSync(join(tmpdir(), "wf-deg-"));
    process.env.AGENTGEM_HOME = home;
    const claudeDir = join(home, ".claude");
    const projDir = join(claudeDir, "projects", "-proj3");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, "t.jsonl"), JSON.stringify({ cwd: "/proj3" }) + "\n");

    const fakeRecommend: typeof recommendWorkflow = async () => ({ analysis: { candidates: [], gaps: [], distilled: [], reflections: [] }, degraded: false });
    const fakeDistill: typeof distillWorkflow = async () => ({ distilled: [], degraded: true });

    const first = await computeWorkflowAnalysis("/proj3", { dir: claudeDir, recommend: fakeRecommend, distill: fakeDistill });
    expect(first.cached).toBe(false);
    expect(first.updatedAt).toBeNull();

    // Cache must NOT have been written — second call still computes.
    const second = await computeWorkflowAnalysis("/proj3", { dir: claudeDir, recommend: fakeRecommend, distill: fakeDistill });
    expect(second.cached).toBe(false);
    expect(second.updatedAt).toBeNull();
  });
});
