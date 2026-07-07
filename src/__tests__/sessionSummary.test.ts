// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarizeSession, clearScanCache } from "@agentgem/insight";

// A Claude transcript is JSONL; filename (minus .jsonl) IS the sessionId. Minimal
// session: user msg, an Edit tool_use, a Bash "pnpm test" tool_use (verification),
// with tool_results. Written under <home>/.claude/projects/proj/.
//
// `extraRetryStorm`: append three identical, benign "ls -la" Bash calls
// back-to-back — enough to trip the retry-storm detector (RETRY_STORM_MIN = 3)
// so tests that need a non-empty `findings` array have one without touching the
// core edit/verify shape the other assertions depend on.
function writeClaudeSession(home: string, sessionId: string, opts: { extraRetryStorm?: boolean } = {}): void {
  const projDir = join(home, ".claude", "projects", "proj");
  mkdirSync(projDir, { recursive: true });
  const ts = (sec: number) => `2026-07-01T10:00:${String(sec).padStart(2, "0")}Z`;
  const lines: unknown[] = [
    { type: "user", cwd: "/repo", gitBranch: "main", timestamp: ts(0), message: { role: "user", content: "fix the bug" } },
    { type: "assistant", cwd: "/repo", timestamp: ts(1), message: { role: "assistant", model: "claude-opus-4-8",
      usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 10 },
      content: [{ type: "tool_use", id: "u1", name: "Edit", input: { file_path: "/repo/src/a.ts", old_string: "x", new_string: "y" } }] } },
    { type: "user", cwd: "/repo", timestamp: ts(2), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "u1", content: "ok" }] } },
    { type: "assistant", cwd: "/repo", timestamp: ts(3), message: { role: "assistant", model: "claude-opus-4-8",
      content: [{ type: "tool_use", id: "u2", name: "Bash", input: { command: "pnpm test" } }] } },
    { type: "user", cwd: "/repo", timestamp: ts(4), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "u2", content: "1 passed" }] } },
  ];
  if (opts.extraRetryStorm) {
    for (let i = 0; i < 3; i++) {
      const id = `r${i}`;
      lines.push({ type: "assistant", cwd: "/repo", timestamp: ts(5 + i * 2), message: { role: "assistant", model: "claude-opus-4-8",
        content: [{ type: "tool_use", id, name: "Bash", input: { command: "ls -la" } }] } });
      lines.push({ type: "user", cwd: "/repo", timestamp: ts(6 + i * 2), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "total 0" }] } });
    }
  }
  writeFileSync(join(projDir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n"));
}

// An ATIF trajectory (non-Claude source, already on this branch) under <home>/atif/.
function writeAtifSession(home: string, sessionId: string): void {
  const atifDir = join(home, "atif"); mkdirSync(atifDir, { recursive: true });
  writeFileSync(join(atifDir, `${sessionId}.json`), JSON.stringify({
    schema_version: "ATIF-v1.7", session_id: sessionId,
    agent: { name: "harbor-agent", version: "1.0.0", model_name: "gemini-2.5-flash" },
    steps: [
      { step_id: 1, source: "user", message: "hello", timestamp: "2026-07-01T10:00:00Z", metrics: { prompt_tokens: 50, completion_tokens: 10 } },
      { step_id: 2, source: "agent", message: "hi", timestamp: "2026-07-01T10:00:05Z" },
    ],
  }));
}

// Both HOME and AGENTGEM_HOME must point at the fixture dir: the Claude scan path
// (resolveDirs()) derives its default from os.homedir() (i.e. $HOME), while the ATIF
// drop dir and agentgemHome()-based state derive from AGENTGEM_HOME — the same
// dual-override the codebase's own hermeticHome.ts fixture uses.
const savedHome = process.env.HOME;
const savedAgentgemHome = process.env.AGENTGEM_HOME;
const homes: string[] = [];
function newHome(): string {
  const h = mkdtempSync(join(tmpdir(), "agentgem-home-"));
  homes.push(h);
  process.env.HOME = h;
  process.env.AGENTGEM_HOME = h;
  return h;
}
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  if (savedAgentgemHome === undefined) delete process.env.AGENTGEM_HOME; else process.env.AGENTGEM_HOME = savedAgentgemHome;
  clearScanCache();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

describe("summarizeSession", () => {
  it("computes a full Claude aggregate: metrics, process quality, stages, findings, events", async () => {
    const home = newHome(); writeClaudeSession(home, "sess-1"); clearScanCache();
    const s = await summarizeSession("sess-1", "claude");
    expect(s).not.toBeNull();
    expect(s!).toMatchObject({ sessionId: "sess-1", agent: "claude", project: "repo", model: "claude-opus-4-8", gitBranch: "main" });
    expect(s!.msgs).toBeGreaterThan(0);
    expect(s!.durationMs).toBe(s!.endMs - s!.startMs);
    expect(s!.process).not.toBeNull();
    expect(typeof s!.process!.score).toBe("number");
    expect(["disciplined", "loose", "chaotic"]).toContain(s!.process!.label);
    expect(s!.process!.stages).toMatchObject({ implementation: expect.any(Number), verification: expect.any(Number) });
    expect(s!.events).not.toBeNull();
    expect(s!.events!.edits).toBeGreaterThanOrEqual(1);
    expect(s!.events!.verifications).toBeGreaterThanOrEqual(1);
    expect(s!.events!.toolCalls.some((tc) => tc.name === "Edit")).toBe(true);
    expect(Array.isArray(s!.findings)).toBe(true);
  });

  it("SECRET-SAFE: the summary contains no message/tool content or file paths", async () => {
    // extraRetryStorm fires the retry-storm detector (three identical "ls -la"
    // calls), so `findings` is non-empty and this test actually exercises
    // DetectorSummary content, not just the metrics/events fields.
    const home = newHome(); writeClaudeSession(home, "sess-2", { extraRetryStorm: true }); clearScanCache();
    const s = await summarizeSession("sess-2", "claude");
    const blob = JSON.stringify(s);
    for (const secret of ["fix the bug", "old_string", "new_string", "/repo/src/a.ts", "1 passed", "pnpm test"]) {
      expect(blob).not.toContain(secret);
    }
    expect(blob).toContain("Edit");   // tool NAMES are allowed (low-cardinality); file paths are not
    expect(s!.findings.length).toBeGreaterThan(0);
    const findingsBlob = JSON.stringify(s!.findings);
    for (const secret of ["fix the bug", "old_string", "new_string", "/repo/src/a.ts", "1 passed", "pnpm test"]) {
      expect(findingsBlob).not.toContain(secret);
    }
  });

  it("non-Claude (ATIF) session returns metrics-only: process/events null, findings empty", async () => {
    const home = newHome(); writeAtifSession(home, "atif-1"); clearScanCache();
    const s = await summarizeSession("atif-1", "atif");
    expect(s).not.toBeNull();
    expect(s!.agent).toBe("atif");
    expect(s!.process).toBeNull();
    expect(s!.events).toBeNull();
    expect(s!.findings).toEqual([]);
  });

  it("returns null for a session id that does not exist", async () => {
    newHome(); clearScanCache();
    expect(await summarizeSession("nope", "claude")).toBeNull();
  });
});
