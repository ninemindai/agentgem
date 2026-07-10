// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WARMABLES } from "../registry.js";
import { distillToken, writeDistillCache, claudeTranscriptsForCwd } from "@agentgem/insight";
import { closeSharedIndex } from "@agentgem/capture";

const orig = process.env.AGENTGEM_HOME;
afterEach(() => { if (orig === undefined) delete process.env.AGENTGEM_HOME; else process.env.AGENTGEM_HOME = orig; });

function observe() { return WARMABLES.find((w) => w.id === "observe")!; }
function usage() { return WARMABLES.find((w) => w.id === "usage")!; }
function scorecard() { return WARMABLES.find((w) => w.id === "scorecard")!; }
function recall() { return WARMABLES.find((w) => w.id === "recall")!; }

describe("observe warmable", () => {
  it("runs first in the pass so the Overview's scan warms before anything else", () => {
    expect(WARMABLES[0]?.id).toBe("observe");
    expect(observe().cost).toBe("cheap");
    expect(observe().scope).toBe("global");
  });

  it("warms the session scan for the given dir", async () => {
    const home = mkdtempSync(join(tmpdir(), "reg-obs-"));
    process.env.AGENTGEM_HOME = home;
    const claudeDir = join(home, ".claude", "projects", "-proj");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "s.jsonl"), JSON.stringify({ type: "assistant", timestamp: "2026-07-01T00:00:00Z", cwd: "/proj", message: { model: "claude-opus-4-8", content: "hi" } }) + "\n");
    try {
      // A custom dir is never cached, so the warmable re-scans (reports "warmed") each call.
      expect(await observe().warm(null, { dir: join(home, ".claude") })).toBe("warmed");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("usage warmable", () => {
  it("warms on first call, then reports a hit on the second (same sessions)", async () => {
    const home = mkdtempSync(join(tmpdir(), "reg-"));
    process.env.AGENTGEM_HOME = home;
    const claudeDir = join(home, ".claude", "projects", "-proj");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "s.jsonl"), JSON.stringify({ cwd: "/proj" }) + "\n");
    const dir = join(home, ".claude");

    try {
      expect(await usage().warm(null, { dir })).toBe("warmed");
      expect(await usage().warm(null, { dir })).toBe("hit");
      expect(await usage().warm(null, { dir, force: true })).toBe("warmed");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // /api/usage serves getGlobalUsageIndexed first and only falls back to the JSON
  // cache when the index throws. Warming via the full scan therefore spent a
  // whole-corpus reparse (~15s on a real home, blocking the loop) on a cache the
  // healthy path never reads. Warm through the index instead — and keep writing the
  // JSON cache, or a later index failure would reparse the corpus inside a request.
  it("warms the transcript index the endpoint reads, and still fills the fallback cache", async () => {
    const home = mkdtempSync(join(tmpdir(), "reg-usage-idx-"));
    process.env.AGENTGEM_HOME = home;
    const claudeDir = join(home, ".claude", "projects", "-proj");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "s.jsonl"), JSON.stringify({ cwd: "/proj" }) + "\n");
    const dir = join(home, ".claude");

    try {
      expect(await usage().warm(null, { dir })).toBe("warmed");
      expect(existsSync(join(home, ".agentgem", "transcript-index.db"))).toBe(true);
      expect(existsSync(join(home, ".agentgem", "global-usage-cache.json"))).toBe(true);
    } finally {
      await closeSharedIndex();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("scorecard warmable", () => {
  it("warms on first call, hits on second, force re-warms", async () => {
    const home = mkdtempSync(join(tmpdir(), "reg-sc-"));
    process.env.AGENTGEM_HOME = home;
    const claudeDir = join(home, ".claude", "projects", "-proj");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "s.jsonl"), JSON.stringify({ cwd: "/proj" }) + "\n");
    const dir = join(home, ".claude");

    try {
      expect(await scorecard().warm(null, { dir })).toBe("warmed");
      expect(await scorecard().warm(null, { dir })).toBe("hit");
      expect(await scorecard().warm(null, { dir, force: true })).toBe("warmed");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("distill warmable", () => {
  it("distill warmable: hit on seeded cache, force recomputes", async () => {
    const home = mkdtempSync(join(tmpdir(), "regd-"));
    const prev = process.env.AGENTGEM_HOME; process.env.AGENTGEM_HOME = home;
    try {
      const claudeDir = join(home, ".claude");
      const projDir = join(claudeDir, "projects", "-proj");
      mkdirSync(projDir, { recursive: true });
      writeFileSync(join(projDir, "s.jsonl"), JSON.stringify({ cwd: "/proj" }) + "\n");
      const token = distillToken(claudeTranscriptsForCwd(claudeDir, "/proj"));
      writeDistillCache("/proj", token, { skills: [], lessons: [], degraded: false }, 1);
      const d = WARMABLES.find((w) => w.id === "distill")!;
      expect(d.cost).toBe("llm"); expect(d.scope).toBe("per-root");
      expect(await d.warm("/proj", { dir: claudeDir })).toBe("hit");
    } finally { if (prev === undefined) delete process.env.AGENTGEM_HOME; else process.env.AGENTGEM_HOME = prev; rmSync(home, { recursive: true, force: true }); }
  });
});

describe("recall warmable", () => {
  it("recall warmable exists with correct cost and scope", () => {
    const r = recall();
    expect(r.cost).toBe("cheap");
    expect(r.scope).toBe("global");
  });

  it("warms end-to-end against an empty home: open → scan → sync → close", async () => {
    const home = mkdtempSync(join(tmpdir(), "reg-recall-"));
    process.env.AGENTGEM_HOME = home;
    const dir = mkdtempSync(join(tmpdir(), "reg-recall-dir-"));

    try {
      // Empty session scan → nothing indexed → (0 indexed + 0 removed) > 0 is false → "hit".
      await expect(recall().warm(null, { dir, force: true })).resolves.toBe("hit");
      expect(existsSync(join(home, ".agentgem", "recall-index.db"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
