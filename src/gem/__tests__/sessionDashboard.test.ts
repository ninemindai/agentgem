// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/__tests__/sessionDashboard.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dashboardToken, readDashboardCacheEntry, readDashboardCacheLatest, writeDashboardCache } from "@agentgem/insight";
import { capDashboardEvents, blastFacts, downsampleCurve, recommendedActions } from "../../sessionDashboardCore.js";
import type { SessionEvent, BlastReport } from "@agentgem/insight";

let home: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "dashcache-"));
  process.env.AGENTGEM_HOME = home;
});
afterAll(() => {
  delete process.env.AGENTGEM_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("dashboardCache", () => {
  it("round-trips (sessionId, token) → html, misses on a stale token, replaces per session", () => {
    writeDashboardCache("s1", "dv1:100", "<html>v1</html>", 1000);
    expect(readDashboardCacheEntry("s1", "dv1:100")).toEqual({ html: "<html>v1</html>", ts: 1000 });
    expect(readDashboardCacheEntry("s1", "dv1:999")).toBeNull();       // transcript changed
    expect(readDashboardCacheEntry("s2", "dv1:100")).toBeNull();       // other session
    writeDashboardCache("s1", "dv1:200", "<html>v2</html>", 2000);     // replaces, never accumulates
    expect(readDashboardCacheEntry("s1", "dv1:100")).toBeNull();
    expect(readDashboardCacheEntry("s1", "dv1:200")?.html).toBe("<html>v2</html>");
  });

  it("keeps summary and report artifacts independently per session", () => {
    writeDashboardCache("s3", "dv1:100", "<html>sum</html>", 1000, "summary");
    writeDashboardCache("s3", "dv1:100", "<html>rep</html>", 2000, "report");
    expect(readDashboardCacheEntry("s3", "dv1:100", "summary")?.html).toBe("<html>sum</html>");
    expect(readDashboardCacheEntry("s3", "dv1:100", "report")?.html).toBe("<html>rep</html>");
    // legacy entries (written before kinds) read back as summary
    expect(readDashboardCacheEntry("s3", "dv1:100")).toEqual({ html: "<html>sum</html>", ts: 1000 });
  });

  it("token derives from the transcript mtime and version", () => {
    const p = join(home, "t.jsonl");
    writeFileSync(p, "{}");
    utimesSync(p, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    expect(dashboardToken(p)).toBe("dv1:1700000000000");
  });

  it("readDashboardCacheLatest serves the entry regardless of token, scoped by kind", () => {
    writeDashboardCache("s4", "dv1:100", "<html>old-sum</html>", 1000, "summary");
    writeDashboardCache("s4", "dv1:100", "<html>old-rep</html>", 2000, "report");
    // token mismatch (transcript changed) — exact read misses, latest read serves
    expect(readDashboardCacheEntry("s4", "dv1:999", "summary")).toBeNull();
    expect(readDashboardCacheLatest("s4", "summary")).toEqual({ html: "<html>old-sum</html>", ts: 1000 });
    expect(readDashboardCacheLatest("s4", "report")).toEqual({ html: "<html>old-rep</html>", ts: 2000 });
    // no entry for that session/kind at all
    expect(readDashboardCacheLatest("s-none", "summary")).toBeNull();
  });
});

const msg = (text: string): SessionEvent => ({ tsMs: 0, span: { kind: "message", role: "user", text } });

describe("report facts", () => {
  it("blastFacts tallies files, edits, outside touches, errors, and top targets/commands", () => {
    const rep: BlastReport = {
      meta: { sessionId: "s", transcript: "s.jsonl", project: "~/p", startMs: 0, endMs: 10 },
      events: [
        { seq: 0, msgIndex: 0, tsMs: 1, tool: "Read", action: "read", target: "src/a.ts", zone: "project" },
        { seq: 1, msgIndex: 1, tsMs: 2, tool: "Edit", action: "edit", target: "src/a.ts", zone: "project" },
        { seq: 2, msgIndex: 2, tsMs: 3, tool: "Read", action: "read", target: "/etc/hosts", zone: "outside", error: true },
        { seq: 3, msgIndex: 3, tsMs: 4, tool: "Bash", action: "exec", target: "git commit" },
        { seq: 4, msgIndex: 4, tsMs: 5, tool: "Bash", action: "exec", target: "git commit" },
        { seq: 5, msgIndex: 5, tsMs: 6, tool: "Skill", action: "skill", target: "qa" },
        { seq: 6, msgIndex: 6, tsMs: 7, tool: "Task", action: "agent", target: "Explore" },
      ],
    };
    const f = blastFacts(rep) as any;
    expect(f).toMatchObject({ events: 7, filesTouched: 2, edited: 1, outsideProject: 1, errors: 1, skills: ["qa"], subagents: ["Explore"] });
    expect(f.topTargets[0]).toMatchObject({ target: "src/a.ts", visits: 2, edited: true });
    expect(f.topCommands).toEqual([{ verb: "git commit", count: 2 }]);
  });

  it("recommendedActions merges fired findings, dedupes by id, ranks warn-first, appends the split suggestion", () => {
    const findings = [
      { id: "retry-loop", title: "Same command repeated", advice: "Read the output first.", severity: "warn" as const, count: 3 },
      { id: "quiet", title: "Never fired", advice: "-", severity: "warn" as const, count: 0 },        // dropped
      { id: "context-pinned", title: "Window pinned", advice: "Cut earlier.", severity: "info" as const, count: 1 },
      { id: "retry-loop", title: "Same command repeated", advice: "dup from hygiene", severity: "warn" as const, count: 3 }, // deduped
    ];
    const actions = recommendedActions(findings, { segments: [{ fromTurn: 0, toTurn: 5 }, { fromTurn: 6, toTurn: 9 }], cutTurn: 6 });
    expect(actions.map((a) => a.id)).toEqual(["retry-loop", "context-pinned", "session-split"]);
    expect(actions[0].severity).toBe("warn");
    expect(actions[2].advice).toMatch(/turn 6/);
    // no boundary, nothing fired → empty
    expect(recommendedActions([{ id: "x", title: "t", advice: "a", severity: "info", count: 0 }])).toEqual([]);
  });

  it("downsampleCurve bounds long curves and always keeps the last point", () => {
    const curve = Array.from({ length: 1000 }, (_, i) => ({ i }));
    const out = downsampleCurve(curve, 240);
    expect(out.length).toBeLessThanOrEqual(241);
    expect(out[out.length - 1]).toEqual({ i: 999 });
    expect(downsampleCurve(curve.slice(0, 10), 240)).toHaveLength(10);
  });
});

describe("capDashboardEvents", () => {
  it("clips long span text and keeps short lists intact", () => {
    const events = [msg("x".repeat(1000)), { tsMs: 1, span: { kind: "tool_call" as const, toolId: "t", name: "Bash", input: "y".repeat(1000) } }];
    const capped = capDashboardEvents(events);
    expect(capped).toHaveLength(2);
    expect((capped[0].span as { text: string }).text.length).toBeLessThanOrEqual(401);
    expect((capped[1].span as { input: string }).input.length).toBeLessThanOrEqual(401);
  });

  it("keeps head + tail with a visible omission marker for long sessions", () => {
    const events = Array.from({ length: 500 }, (_, i) => msg(`e${i}`));
    const capped = capDashboardEvents(events);
    expect(capped).toHaveLength(141);                                   // 20 head + marker + 120 tail
    expect((capped[0].span as { text: string }).text).toBe("e0");
    expect((capped[20].span as { text: string }).text).toMatch(/360 events omitted/);
    expect((capped[capped.length - 1].span as { text: string }).text).toBe("e499");
  });
});
