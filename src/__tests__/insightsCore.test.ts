// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insightsToken, writeInsightsCache, claudeTranscriptsForCwd } from "@agentgem/insight";
import { computeInsights } from "../insightsCore.js";

const orig = { home: process.env.AGENTGEM_HOME };
afterEach(() => {
  if (orig.home === undefined) delete process.env.AGENTGEM_HOME; else process.env.AGENTGEM_HOME = orig.home;
});

describe("computeInsights", () => {
  it("returns the cached payload without recomputing when the token matches", async () => {
    const home = mkdtempSync(join(tmpdir(), "ins-"));
    process.env.AGENTGEM_HOME = home;
    // A claudeDir with one transcript for project root /proj so the token is stable.
    const claudeDir = join(home, ".claude");
    const projDir = join(claudeDir, "projects", "-proj");
    mkdirSync(projDir, { recursive: true });
    const f = join(projDir, "s.jsonl");
    writeFileSync(f, JSON.stringify({ cwd: "/proj" }) + "\n");

    const paths = claudeTranscriptsForCwd(claudeDir, "/proj");
    const token = insightsToken(paths);
    const payload = { report: { totals: {} }, facets: [], degraded: false, signalSummary: { sessionsScanned: 1, spanDays: 0, notes: [] } };
    writeInsightsCache("/proj", token, payload, 777);

    const res = await computeInsights("/proj", { dir: claudeDir });
    expect(res.cached).toBe(true);
    expect(res.updatedAt).toBe(777);
    expect((res.payload.report as { totals: unknown }).totals).toEqual({});
  });
});
