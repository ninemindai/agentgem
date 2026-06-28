import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanSessions, parseClaudeTranscript, parseCodexTranscript, type SessionStat } from "../observeScan.js";

let home: string, claudeDir: string, codexDir: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "observe-"));
  claudeDir = join(home, ".claude");
  codexDir = join(home, ".codex");
  // Claude: ~/.claude/projects/<folder>/<session>.jsonl
  const cproj = join(claudeDir, "projects", "proj-a");
  mkdirSync(cproj, { recursive: true });
  writeFileSync(join(cproj, "s1.jsonl"), [
    JSON.stringify({ type: "user", sessionId: "s1", cwd: "/work/app", timestamp: "2026-06-28T10:00:00.000Z", message: { role: "user" } }),
    JSON.stringify({ type: "assistant", sessionId: "s1", cwd: "/work/app", timestamp: "2026-06-28T10:00:05.000Z", message: { role: "assistant", model: "claude-opus-4-8", usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 } } }),
    JSON.stringify({ type: "assistant", sessionId: "s1", cwd: "/work/app", timestamp: "2026-06-28T10:01:00.000Z", message: { role: "assistant", model: "claude-opus-4-8", usage: { input_tokens: 200, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }),
    "{ not json",
  ].join("\n") + "\n");
  // Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
  const xdir = join(codexDir, "sessions", "2026", "06", "28");
  mkdirSync(xdir, { recursive: true });
  writeFileSync(join(xdir, "rollout-x1.jsonl"), [
    JSON.stringify({ type: "session_meta", timestamp: "2026-06-28T11:00:00.000Z", payload: { id: "x1", cwd: "/work/web", timestamp: "2026-06-28T11:00:00.000Z" } }),
    JSON.stringify({ type: "turn_context", timestamp: "2026-06-28T11:00:01.000Z", payload: { model: "gpt-5.5" } }),
    JSON.stringify({ type: "response_item", timestamp: "2026-06-28T11:00:02.000Z", payload: { type: "message", role: "assistant" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-06-28T11:05:00.000Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 500, cached_input_tokens: 200, output_tokens: 80, reasoning_output_tokens: 20, total_tokens: 600 } } } }),
  ].join("\n") + "\n");
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("parseClaudeTranscript", () => {
  it("normalizes tokens (fresh in / cache / out), timing, msgs, model", () => {
    const s = parseClaudeTranscript(join(claudeDir, "projects", "proj-a", "s1.jsonl"))!;
    expect(s.agent).toBe("claude");
    expect(s.sessionId).toBe("s1");
    expect(s.project).toBe("app");          // basename of cwd
    expect(s.model).toBe("claude-opus-4-8");
    expect(s.tokensIn).toBe(300);           // 100 + 200 (cache excluded)
    expect(s.tokensOut).toBe(100);          // 40 + 60
    expect(s.tokensCache).toBe(15);         // 10 read + 5 creation
    expect(s.msgs).toBe(3);                 // 1 user + 2 assistant
    expect(s.endMs - s.startMs).toBe(60_000); // 10:00:00 → 10:01:00
  });
});

describe("parseCodexTranscript", () => {
  it("uses cumulative total_token_usage, session_meta id/cwd, found model", () => {
    const s = parseCodexTranscript(join(codexDir, "sessions", "2026", "06", "28", "rollout-x1.jsonl"))!;
    expect(s.agent).toBe("codex");
    expect(s.sessionId).toBe("x1");
    expect(s.project).toBe("web");
    expect(s.model).toBe("gpt-5.5");
    expect(s.tokensIn).toBe(300);           // 500 input − 200 cached
    expect(s.tokensCache).toBe(200);
    expect(s.tokensOut).toBe(100);          // 80 + 20 reasoning
    expect(s.endMs - s.startMs).toBe(300_000); // 11:00:00 → 11:05:00
  });
});

describe("scanSessions", () => {
  it("returns both agents and skips a missing codex dir without throwing", () => {
    const stats = scanSessions({ claudeDir, codexDir });
    expect(stats.map((s) => s.sessionId).sort()).toEqual(["s1", "x1"]);
    const missing = scanSessions({ claudeDir, codexDir: join(home, "nope") });
    expect(missing.map((s) => s.sessionId)).toEqual(["s1"]);
  });
});
