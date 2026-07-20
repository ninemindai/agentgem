// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/goldmine/__tests__/behaviorFindings.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectBehaviorFindings } from "@agentgem/app/goldmine/behaviorFindings";

const NOW = 1_750_000_000_000; // fixed clock for window tests
const DAY = 86_400_000;

let tmp: string | undefined;
afterEach(() => { if (tmp) { rmSync(tmp, { recursive: true, force: true }); tmp = undefined; } });

// A claudeDir with one project folder; returns the projects subdir to drop transcripts into.
function makeClaudeDir(): { claudeDir: string; projDir: string } {
  tmp = mkdtempSync(join(tmpdir(), "coach-"));
  const claudeDir = join(tmp, ".claude");
  const projDir = join(claudeDir, "projects", "-proj");
  mkdirSync(projDir, { recursive: true });
  return { claudeDir, projDir };
}

const bashLine = (cmd: string) => ({
  sessionId: "s-fix",
  message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: cmd } }] },
});

function writeTranscript(dir: string, name: string, lines: unknown[], mtimeMs = NOW): string {
  const p = join(dir, name);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
  return p;
}

describe("collectBehaviorFindings", () => {
  it("detects a retry-storm in a fixture transcript and summarizes it", () => {
    const { claudeDir, projDir } = makeClaudeDir();
    writeTranscript(projDir, "storm.jsonl", [
      bashLine("npm run deploy"), bashLine("npm run deploy"), bashLine("npm run deploy"),
    ]);
    const r = collectBehaviorFindings({ dir: claudeDir, rulesDir: join(claudeDir, "no-rules"), now: () => NOW });
    expect(r.scanned.transcripts).toBe(1);
    expect(r.scanned.sessions).toBe(1);   // the fixture session retained steps
    expect(r.findings.some((f) => f.detectorId === "retry-storm")).toBe(true);
    const storm = r.summary.find((s) => s.id === "retry-storm");
    expect(storm?.count).toBe(1);
    expect(storm?.advice.length).toBeGreaterThan(0);
  });

  it("excludes transcripts older than the days window", () => {
    const { claudeDir, projDir } = makeClaudeDir();
    writeTranscript(projDir, "old.jsonl",
      [bashLine("npm run deploy"), bashLine("npm run deploy"), bashLine("npm run deploy")],
      NOW - 30 * DAY);
    const r = collectBehaviorFindings({ days: 14, dir: claudeDir, rulesDir: join(claudeDir, "no-rules"), now: () => NOW });
    expect(r.scanned.transcripts).toBe(0);
    expect(r.summary).toEqual([]);
    expect(r.findings).toEqual([]);
  });

  it("caps the number of transcripts scanned (newest first)", () => {
    const { claudeDir, projDir } = makeClaudeDir();
    writeTranscript(projDir, "a.jsonl", [bashLine("git status")], NOW - 2 * DAY);
    writeTranscript(projDir, "b.jsonl", [bashLine("git status")], NOW - DAY);
    const r = collectBehaviorFindings({ maxTranscripts: 1, dir: claudeDir, rulesDir: join(claudeDir, "no-rules"), now: () => NOW });
    expect(r.scanned.transcripts).toBe(1);
  });

  it("picks up user-defined rules from rulesDir", () => {
    const { claudeDir, projDir } = makeClaudeDir();
    writeTranscript(projDir, "s.jsonl", [
      bashLine("npm run deploy"), bashLine("npm run deploy"), bashLine("npm run deploy"),
    ]);
    const rulesDir = join(claudeDir, "detector-rules");
    mkdirSync(rulesDir, { recursive: true });
    // bashVerb("npm run deploy") = "Bash:npm run" — argv0 + first lowercase subcommand
    writeFileSync(join(rulesDir, "r.json"), JSON.stringify({
      id: "npm-heavy", title: "Heavy npm use", advice: "Batch npm invocations.",
      pattern: ["Bash:npm run"], minRepeats: 3,
    }));
    const r = collectBehaviorFindings({ dir: claudeDir, rulesDir, now: () => NOW });
    expect(r.summary.map((s) => s.id)).toContain("npm-heavy");
  });

  it("returns the empty result (never throws) when the claudeDir does not exist", () => {
    const r = collectBehaviorFindings({ dir: "/nonexistent/claude", rulesDir: "/nonexistent/rules", now: () => NOW });
    expect(r).toEqual({ summary: [], findings: [], scanned: { transcripts: 0, sessions: 0, days: 14 } });
  });

  it("clamps out-of-range options", () => {
    const { claudeDir, projDir } = makeClaudeDir();
    writeTranscript(projDir, "a.jsonl", [bashLine("git status")], NOW - 2 * DAY);
    writeTranscript(projDir, "b.jsonl", [bashLine("git status")], NOW - DAY);
    const r = collectBehaviorFindings({ days: 9999, maxTranscripts: -5, dir: claudeDir, rulesDir: join(claudeDir, "no-rules"), now: () => NOW });
    expect(r.scanned.days).toBe(90);        // days clamped to 90
    expect(r.scanned.transcripts).toBe(1);  // maxTranscripts clamped to 1
  });
});
