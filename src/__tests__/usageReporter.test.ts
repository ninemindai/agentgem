// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionStat } from "@agentgem/insight";
import { usageDaysFromStats, reportUsageOnce, startUsageReporter, ownerFromRemoteUrl, scopeForCwd, REPORT_WINDOW_DAYS } from "../usage/reporter.js";

const DAY = 86_400_000;
const T0 = Date.parse("2026-07-04T10:00:00Z");

const stat = (over: Partial<SessionStat> = {}): SessionStat => ({
  agent: "claude", sessionId: "s1", project: "p", model: "m", gitBranch: null,
  startMs: T0, endMs: T0 + 60_000, msgs: 4, tokensIn: 100, tokensOut: 50, tokensCache: 1_000,
  ...over,
});

const session = () => ({ sessionToken: "tok", login: "alice" });
const tmpHome = () => mkdtempSync(join(tmpdir(), "agentgem-usage-"));

describe("usageDaysFromStats", () => {
  it("buckets sessions by UTC end day and sums duration", () => {
    const rows = usageDaysFromStats([
      stat(),
      stat({ sessionId: "s2", startMs: T0 + 3_600_000, endMs: T0 + 3_660_000 }),
      stat({ sessionId: "s3", startMs: T0 + DAY, endMs: T0 + DAY + 120_000, tokensIn: 7 }),
    ], 0);
    expect(rows.map((r) => r.date)).toEqual(["2026-07-04", "2026-07-05"]);
    expect(rows[0]).toMatchObject({ sessions: 2, msgs: 8, tokensIn: 200, activeMs: 120_000 });
    expect(rows[1]).toMatchObject({ sessions: 1, tokensIn: 7 });
  });
  it("drops sessions older than the window and negative durations", () => {
    const rows = usageDaysFromStats([
      stat({ endMs: T0 - (REPORT_WINDOW_DAYS + 1) * DAY }),
      stat({ startMs: T0 + 5_000, endMs: T0 }), // clock skew: clamps to 0, still counted
    ], T0 - REPORT_WINDOW_DAYS * DAY);
    expect(rows).toHaveLength(1);
    expect(rows[0].activeMs).toBe(0);
  });
});

describe("reportUsageOnce", () => {
  it("skips when signed out without scanning", async () => {
    const scan = vi.fn();
    const out = await reportUsageOnce({ home: tmpHome(), session: () => null, scan, now: T0 });
    expect(out).toEqual({ ok: false, reason: "signed-out" });
    expect(scan).not.toHaveBeenCalled();
  });

  it("POSTs the rollup with the Bearer session and records state", async () => {
    const home = tmpHome();
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe("https://agg.example/api/usage/report");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
      const body = JSON.parse(String(init?.body)) as { machine: string; days: unknown[] };
      expect(body.machine).toBe("test-machine");
      expect(body.days).toHaveLength(1);
      return { ok: true, json: async () => ({ recorded: 1 }) } as Response;
    });
    const out = await reportUsageOnce({
      home, now: T0, session: session as never, base: "https://agg.example", machine: "test-machine",
      scan: async () => [stat()], fetchImpl: fetchImpl as never,
    });
    expect(out).toEqual({ ok: true, recorded: 1 });
    expect(JSON.parse(readFileSync(join(home, ".agentgem", "usage-report.json"), "utf8")).lastReportAt).toBe(new Date(T0).toISOString());
  });

  it("throttles a second pass within the interval, unless forced", async () => {
    const home = tmpHome();
    mkdirSync(join(home, ".agentgem"), { recursive: true });
    writeFileSync(join(home, ".agentgem", "usage-report.json"), JSON.stringify({ lastReportAt: new Date(T0 - 60_000).toISOString() }));
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ recorded: 1 }) }) as unknown as Response);
    const throttled = await reportUsageOnce({ home, now: T0, session: session as never, scan: async () => [stat()], fetchImpl: fetchImpl as never });
    expect(throttled).toEqual({ ok: false, reason: "throttled" });
    const forced = await reportUsageOnce({ home, now: T0, force: true, session: session as never, base: "https://agg.example", scan: async () => [stat()], fetchImpl: fetchImpl as never });
    expect(forced.ok).toBe(true);
  });

  it("reports no-usage when the window is empty and surfaces http failures", async () => {
    const home = tmpHome();
    const empty = await reportUsageOnce({ home, now: T0, session: session as never, scan: async () => [], fetchImpl: vi.fn() as never });
    expect(empty).toEqual({ ok: false, reason: "no-usage" });
    const denied = await reportUsageOnce({
      home, now: T0, session: session as never, base: "https://agg.example",
      scan: async () => [stat()], fetchImpl: (async () => ({ ok: false, status: 401 })) as never,
    });
    expect(denied).toEqual({ ok: false, reason: "http-401" });
  });
});

describe("startUsageReporter", () => {
  it("runs a pass at start and stops cleanly", async () => {
    vi.useFakeTimers();
    try {
      const scan = vi.fn(async () => []);
      const r = startUsageReporter({ home: tmpHome(), session: session as never, scan, fetchImpl: vi.fn() as never, intervalMs: 1_000 });
      await vi.advanceTimersByTimeAsync(10);
      expect(scan).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(scan).toHaveBeenCalledTimes(2);
      r.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(scan).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("repo-owner attribution", () => {
  it("ownerFromRemoteUrl parses ssh/https/scp remote forms, lowercased", () => {
    expect(ownerFromRemoteUrl("git@github.com:NineMind/agentgem.git")).toBe("ninemind");
    expect(ownerFromRemoteUrl("https://github.com/ninemindai/agentgem.git")).toBe("ninemindai");
    expect(ownerFromRemoteUrl("https://github.com/acme/repo")).toBe("acme");
    expect(ownerFromRemoteUrl("ssh://git@github.com/Acme/repo.git")).toBe("acme");
    expect(ownerFromRemoteUrl("not a url")).toBe("");
  });

  it("scopeForCwd walks up to the repo root and reads remote origin", () => {
    const files: Record<string, string> = { "/repo/.git/config": '[remote "origin"]\n\turl = git@github.com:ninemind/agentgem.git\n' };
    const fs = { readFile: (p: string) => files[p] ?? null, isDir: (p: string) => p === "/repo/.git" };
    expect(scopeForCwd("/repo/packages/console/src", fs)).toBe("ninemind");
    expect(scopeForCwd("/elsewhere/no-repo", fs)).toBe("");
    expect(scopeForCwd(null, fs)).toBe("");
  });

  it("scopeForCwd resolves a linked worktree's .git FILE to the main repo config", () => {
    const files: Record<string, string> = {
      "/wt/.git": "gitdir: /main/.git/worktrees/wt\n",
      "/main/.git/config": '[remote "origin"]\n\turl = https://github.com/acme/repo.git\n',
    };
    const fs = { readFile: (p: string) => files[p] ?? null, isDir: () => false };
    expect(scopeForCwd("/wt", fs)).toBe("acme");
  });

  it("scopeForCwd yields '' when the repo has no origin remote", () => {
    const files: Record<string, string> = { "/repo/.git/config": "[core]\n\tbare = false\n" };
    const fs = { readFile: (p: string) => files[p] ?? null, isDir: (p: string) => p === "/repo/.git" };
    expect(scopeForCwd("/repo", fs)).toBe("");
  });

  it("usageDaysFromStats buckets per (scope, day) so org rows never mix with personal rows", () => {
    const scopeOf = (cwd: string | null | undefined) => (cwd === "/work/agentgem" ? "ninemind" : cwd === "/me/dotfiles" ? "alice" : "");
    const rows = usageDaysFromStats([
      stat({ cwd: "/work/agentgem", tokensIn: 100 }),
      stat({ sessionId: "s2", cwd: "/work/agentgem", tokensIn: 20 }),
      stat({ sessionId: "s3", cwd: "/me/dotfiles", tokensIn: 7 }),
      stat({ sessionId: "s4", cwd: null, tokensIn: 3 }),
    ], 0, scopeOf);
    expect(rows.map((r) => [r.scope, r.tokensIn, r.sessions])).toEqual([
      ["", 3, 1], ["alice", 7, 1], ["ninemind", 120, 2],
    ]);
    expect(rows.every((r) => r.date === "2026-07-04")).toBe(true);
  });
});
