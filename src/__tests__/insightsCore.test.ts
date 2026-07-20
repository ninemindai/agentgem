// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insightsToken, writeInsightsCache, claudeTranscriptsForCwd, judgeSessions, narrateInsights } from "@agentgem/insight";
import { computeInsights } from "@agentgem/app/insightsCore";

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
    const payload = { report: { totals: {} }, facets: [], findings: [], detectorSummary: [], degraded: false, signalSummary: { sessionsScanned: 1, spanDays: 0, notes: [] } };
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

    const fakeJudge: typeof judgeSessions = async () => ({ facets: [], degraded: false });
    const fakeNarrate: typeof narrateInsights = async () => ({ narrative: "ok", degraded: false });

    const first = await computeInsights("/proj2", { dir: claudeDir, judge: fakeJudge, narrate: fakeNarrate });
    expect(first.cached).toBe(false);
    expect(typeof first.updatedAt).toBe("number");
    // Detector wiring: a transcript with no tool steps yields empty findings,
    // but the fields must exist on a fresh payload.
    expect(first.payload.findings).toEqual([]);
    expect(first.payload.detectorSummary).toEqual([]);

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

    const fakeJudge: typeof judgeSessions = async () => ({ facets: [], degraded: true });
    const fakeNarrate: typeof narrateInsights = async () => ({ narrative: "ok", degraded: false });

    const first = await computeInsights("/proj3", { dir: claudeDir, judge: fakeJudge, narrate: fakeNarrate });
    expect(first.cached).toBe(false);
    expect(first.updatedAt).toBeNull();

    // Cache must NOT have been written — second call still computes.
    const second = await computeInsights("/proj3", { dir: claudeDir, judge: fakeJudge, narrate: fakeNarrate });
    expect(second.cached).toBe(false);
    expect(second.updatedAt).toBeNull();
  });

  it("adding a detector rule file rotates the token and busts the cache", async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "ins-rules-"));
    process.env.AGENTGEM_HOME = tmpHome;
    const claudeDir = join(tmpHome, ".claude");
    const projDir = join(claudeDir, "projects", "-proj4");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, "t.jsonl"), JSON.stringify({ cwd: "/proj4" }) + "\n");

    const fakeJudge: typeof judgeSessions = async () => ({ facets: [], degraded: false });
    const fakeNarrate: typeof narrateInsights = async () => ({ narrative: "ok", degraded: false });

    const first = await computeInsights("/proj4", { dir: claudeDir, judge: fakeJudge, narrate: fakeNarrate });
    expect(first.cached).toBe(false);
    const second = await computeInsights("/proj4", { dir: claudeDir, judge: fakeJudge, narrate: fakeNarrate });
    expect(second.cached).toBe(true);

    // Author a rule — the next compute must MISS the cache and recompute.
    const rulesDir = join(tmpHome, ".agentgem", "detectors");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, "my.json"), JSON.stringify({ id: "my-rule", title: "T", advice: "A", pattern: ["Edit"] }));
    const third = await computeInsights("/proj4", { dir: claudeDir, judge: fakeJudge, narrate: fakeNarrate });
    expect(third.cached).toBe(false);
  });
});
