// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Collector tests: window/floor filtering, sample cap, codex guard, and the
// pure browser-open command builder. All session sources injected — no fs.
import { describe, expect, it } from "vitest";
import type { SessionStat } from "@agentgem/insight";
import { collectGemitInputs } from "../gemit/collect.js";
import { openCommand } from "../gemit/openBrowser.js";
import { MIN_MSGS, SAMPLE_CAP } from "../gemit/score.js";

const NOW = Date.UTC(2026, 6, 18);
const DAY = 24 * 3600 * 1000;

function stat(over: Partial<SessionStat> = {}): SessionStat {
  return {
    agent: "claude" as SessionStat["agent"],
    sessionId: "s" + Math.random().toString(36).slice(2),
    project: "proj", cwd: "/Users/x/proj", model: "claude-fable-5", gitBranch: null,
    startMs: NOW - 2 * DAY, endMs: NOW - DAY, msgs: 20,
    tokensIn: 10, tokensOut: 100, tokensCache: 0,
    skills: { alpha: 2 }, subagents: {},
    ...over,
  };
}

describe("collectGemitInputs", () => {
  it("filters to the window and message floor, newest first", async () => {
    const stats = [
      stat({ sessionId: "old", endMs: NOW - 40 * DAY }),
      stat({ sessionId: "thin", msgs: MIN_MSGS - 1 }),
      stat({ sessionId: "ok-older", endMs: NOW - 5 * DAY }),
      stat({ sessionId: "ok-newer", endMs: NOW - DAY }),
    ];
    const { qualifying, scored } = await collectGemitInputs(undefined, NOW, {
      scan: async () => stats,
      summarize: async () => null,
      hygieneFor: async () => null,
    });
    expect(qualifying.map((q) => q.sessionId)).toEqual(["ok-newer", "ok-older"]);
    expect(scored).toHaveLength(2);
  });

  it("caps scoring at SAMPLE_CAP but keeps all qualifying", async () => {
    const stats = Array.from({ length: SAMPLE_CAP + 25 }, (_, i) =>
      stat({ sessionId: `s${i}`, endMs: NOW - DAY - i * 1000 }));
    let summarized = 0;
    const { qualifying, scored } = await collectGemitInputs(undefined, NOW, {
      scan: async () => stats,
      summarize: async () => { summarized++; return null; },
      hygieneFor: async () => null,
    });
    expect(qualifying).toHaveLength(SAMPLE_CAP + 25);
    expect(scored).toHaveLength(SAMPLE_CAP);
    expect(summarized).toBe(SAMPLE_CAP);
  });

  it("never asks for hygiene on non-claude sessions", async () => {
    const hygieneCalls: string[] = [];
    const { scored } = await collectGemitInputs(undefined, NOW, {
      scan: async () => [
        stat({ sessionId: "c1" }),
        stat({ sessionId: "x1", agent: "codex" as SessionStat["agent"] }),
      ],
      summarize: async () => null,
      hygieneFor: async (id) => { hygieneCalls.push(id); return { score: 90, verdict: "bounded", findings: [] }; },
    });
    expect(hygieneCalls).toEqual(["c1"]);
    const codex = scored.find((r) => r.session.agent === "codex")!;
    expect(codex.hygieneScore).toBeNull();
    expect(codex.hygieneVerdict).toBeNull();
  });

  it("merges hygiene + summary findings and maps events/process fields", async () => {
    const { scored } = await collectGemitInputs(undefined, NOW, {
      scan: async () => [stat({ sessionId: "c1" })],
      summarize: async () => ({
        sessionId: "c1", agent: "claude", project: null, model: null, gitBranch: null,
        startMs: 0, endMs: NOW - DAY, durationMs: 1, msgs: 20,
        tokensIn: 0, tokensOut: 0, tokensCache: 0,
        process: { score: 77, label: "loose", stages: { exploration: 0, implementation: 0, verification: 0, orchestration: 0, other: 0 } },
        findings: [{ id: "retry-storm", title: "Retry storm", advice: "", severity: "warn", count: 2, sessions: 1 }],
        events: { toolCalls: [], filesTouched: 1, edits: 1, verifications: 3 },
      }),
      hygieneFor: async () => ({
        score: 88, verdict: "bounded",
        findings: [{ id: "task-sprawl", title: "Sprawl", count: 0 }],
      }),
    });
    const r = scored[0];
    expect(r.hygieneScore).toBe(88);
    expect(r.processScore).toBe(77);
    expect(r.processLabel).toBe("loose");
    expect(r.verifications).toBe(3);
    expect(r.findings.map((f) => f.id).sort()).toEqual(["retry-storm", "task-sprawl"]);
  });
});

describe("openCommand", () => {
  it("builds the per-platform opener", () => {
    expect(openCommand("darwin", "/tmp/r.html")).toEqual({ cmd: "open", args: ["/tmp/r.html"] });
    expect(openCommand("linux", "/tmp/r.html")).toEqual({ cmd: "xdg-open", args: ["/tmp/r.html"] });
    expect(openCommand("win32", "C:\\r.html")).toEqual({ cmd: "cmd", args: ["/c", "start", "", "C:\\r.html"] });
    expect(openCommand("freebsd" as NodeJS.Platform, "x")).toBeNull();
  });
});
