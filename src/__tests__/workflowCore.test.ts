// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcriptToken, writeAnalysisCache, claudeTranscriptsForCwd } from "@agentgem/insight";
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
});
