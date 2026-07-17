// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clearScanCache, writeAnalysisCache } from "@agentgem/insight";
import { SCORECARD_CACHE_ROOT } from "../gem/scorecard.js";
import { HomeController, CLAUDE_GATE_MIN_SESSIONS } from "../home.controller.js";
import { useHermeticHome } from "./support/hermeticHome.js";

let restoreHome: () => void;
let home: string;
beforeEach(() => {
  restoreHome = useHermeticHome();
  home = process.env.HOME!;
  clearScanCache();
});
afterEach(() => {
  restoreHome();
  clearScanCache();
});

// One Claude session directory (`.claude/projects/<project>/<sessionId>.jsonl`) with a
// user record (cwd + start time) and an assistant record (end time + usage tokens) —
// the minimal shape parseClaudeTranscript needs to count a session.
function claudeSession(
  project: string, sessionId: string,
  opts: { startIso: string; endIso: string; tokensIn?: number; tokensOut?: number; tokensCache?: number },
): void {
  const dir = join(home, ".claude", "projects", project);
  mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "user", timestamp: opts.startIso, cwd: `/home/u/${project}`, message: { content: "hi" } }),
    JSON.stringify({
      type: "assistant", timestamp: opts.endIso,
      message: {
        model: "claude-opus-4-8", content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: opts.tokensIn ?? 0, output_tokens: opts.tokensOut ?? 0, cache_read_input_tokens: opts.tokensCache ?? 0 },
      },
    }),
  ];
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.join("\n") + "\n");
}

describe("HomeController.summary", () => {
  it("returns a zeroed composed shape on an empty home (both gate flags trip)", async () => {
    const out = await new HomeController().summary();
    expect(out).toEqual({
      usage: { sessions: 0, spanDays: 0, activeMs: 0, tokensIn: 0, tokensOut: 0, tokensCache: 0 },
      claudeSessions: 0,
      gate: { usageEmpty: true, claudeBelowGate: true },
      scorecardCached: false,
      projectsScanned: 0,
      projectsCap: 12,
    });
  });

  it("aggregates usage totals across Claude sessions (tokens, activeMs, spanDays)", async () => {
    claudeSession("proj-a", "s1", { startIso: "2026-07-01T00:00:00Z", endIso: "2026-07-01T00:10:00Z", tokensIn: 100, tokensOut: 50, tokensCache: 10 });
    claudeSession("proj-a", "s2", { startIso: "2026-07-03T00:00:00Z", endIso: "2026-07-03T00:05:00Z", tokensIn: 200, tokensOut: 20, tokensCache: 5 });

    const out = await new HomeController().summary();
    expect(out.usage.sessions).toBe(2);
    expect(out.usage.tokensIn).toBe(300);
    expect(out.usage.tokensOut).toBe(70);
    expect(out.usage.tokensCache).toBe(15);
    expect(out.usage.activeMs).toBe(10 * 60_000 + 5 * 60_000);
    expect(out.usage.spanDays).toBe(2); // 2026-07-01T00:00 -> 2026-07-03T00:05, rounds to 2
    expect(out.claudeSessions).toBe(2);
    expect(out.gate.usageEmpty).toBe(false);
    expect(out.gate.claudeBelowGate).toBe(true); // 2 < 10
  });

  it("flips claudeBelowGate at the 9→10 Claude-session boundary", async () => {
    for (let i = 0; i < CLAUDE_GATE_MIN_SESSIONS - 1; i++) {
      claudeSession("proj-b", `s${i}`, { startIso: `2026-07-01T00:0${i}:00Z`, endIso: `2026-07-01T00:0${i}:30Z` });
    }
    const below = await new HomeController().summary();
    expect(below.claudeSessions).toBe(9);
    expect(below.gate.claudeBelowGate).toBe(true);

    claudeSession("proj-b", "s9", { startIso: "2026-07-01T00:09:00Z", endIso: "2026-07-01T00:09:30Z" });
    clearScanCache(); // force a re-scan now that a 10th session landed
    const atGate = await new HomeController().summary();
    expect(atGate.claudeSessions).toBe(10);
    expect(atGate.gate.claudeBelowGate).toBe(false);
  });

  it("scorecardCached reflects whether an aggregate scorecard cache entry exists", async () => {
    const before = await new HomeController().summary();
    expect(before.scorecardCached).toBe(false);

    writeAnalysisCache(SCORECARD_CACHE_ROOT, "tok", { breadth: 1, battleTested: 0, portable: 0, gaps: [], projects: [], generatedAtMs: 1, degraded: false }, Date.now());
    const after = await new HomeController().summary();
    expect(after.scorecardCached).toBe(true);
  });

  it("caps projectsScanned at projectsCap (12) when more projects are discovered", async () => {
    for (let i = 0; i < 15; i++) {
      claudeSession(`proj-${i}`, "s1", { startIso: `2026-07-0${(i % 9) + 1}T00:00:00Z`, endIso: `2026-07-0${(i % 9) + 1}T00:01:00Z` });
    }
    const out = await new HomeController().summary();
    expect(out.projectsScanned).toBe(12);
    expect(out.projectsCap).toBe(12);
  });

  it("reports the exact discovered count when under the cap", async () => {
    claudeSession("proj-x", "s1", { startIso: "2026-07-01T00:00:00Z", endIso: "2026-07-01T00:01:00Z" });
    claudeSession("proj-y", "s1", { startIso: "2026-07-01T00:00:00Z", endIso: "2026-07-01T00:01:00Z" });
    const out = await new HomeController().summary();
    expect(out.projectsScanned).toBe(2);
  });
});
