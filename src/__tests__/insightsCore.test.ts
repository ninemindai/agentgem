// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insightsToken, writeInsightsCache, claudeTranscriptsForCwd } from "@agentgem/insight";
import { computeInsights } from "../insightsCore.js";

const orig = { home: process.env.AGENTGEM_HOME };
let tmpHome: string | undefined;
afterEach(() => {
  if (orig.home === undefined) delete process.env.AGENTGEM_HOME; else process.env.AGENTGEM_HOME = orig.home;
  if (tmpHome) { rmSync(tmpHome, { recursive: true, force: true }); tmpHome = undefined; }
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

  it("fresh non-degraded compute: writes cache, second call returns hit", async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "ins-nd-"));
    process.env.AGENTGEM_HOME = tmpHome;
    const claudeDir = join(tmpHome, ".claude");
    const projDir = join(claudeDir, "projects", "-proj2");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, "t.jsonl"), JSON.stringify({ cwd: "/proj2" }) + "\n");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeJudge = (async () => ({ facets: [], degraded: false })) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeNarrate = (async () => ({ narrative: "ok", degraded: false })) as any;

    const first = await computeInsights("/proj2", { dir: claudeDir, judge: fakeJudge, narrate: fakeNarrate });
    expect(first.cached).toBe(false);
    expect(typeof first.updatedAt).toBe("number");

    // Second call without force — must hit the cache written by the first call.
    const second = await computeInsights("/proj2", { dir: claudeDir, judge: fakeJudge, narrate: fakeNarrate });
    expect(second.cached).toBe(true);
    expect(second.updatedAt).toBe(first.updatedAt);
  });

  it("degraded compute: does not write cache, repeated calls stay uncached", async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "ins-deg-"));
    process.env.AGENTGEM_HOME = tmpHome;
    const claudeDir = join(tmpHome, ".claude");
    const projDir = join(claudeDir, "projects", "-proj3");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, "t.jsonl"), JSON.stringify({ cwd: "/proj3" }) + "\n");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeJudge = (async () => ({ facets: [], degraded: true })) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeNarrate = (async () => ({ narrative: "ok", degraded: false })) as any;

    const first = await computeInsights("/proj3", { dir: claudeDir, judge: fakeJudge, narrate: fakeNarrate });
    expect(first.cached).toBe(false);
    expect(first.updatedAt).toBeNull();

    // Cache must NOT have been written — second call still computes.
    const second = await computeInsights("/proj3", { dir: claudeDir, judge: fakeJudge, narrate: fakeNarrate });
    expect(second.cached).toBe(false);
    expect(second.updatedAt).toBeNull();
  });
});
