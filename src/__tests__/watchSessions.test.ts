import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listActiveSessions, resolveTranscriptFile, agentForFile, watchRoots } from "../watchSessions.js";

let home: string, claudeDir: string, proj: string, freshFile: string, staleFile: string;
const NOW = Date.parse("2026-07-03T12:00:00.000Z");

const rec = (o: unknown) => JSON.stringify(o);

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "watch-"));
  claudeDir = join(home, ".claude");
  proj = join(claudeDir, "projects", "proj-a");
  mkdirSync(proj, { recursive: true });

  freshFile = join(proj, "fresh-uuid.jsonl");
  writeFileSync(freshFile, [
    rec({ type: "user", cwd: "/work/site", timestamp: "2026-07-03T11:59:00.000Z", message: { role: "user" } }),
    rec({ type: "assistant", cwd: "/work/site", timestamp: "2026-07-03T11:59:30.000Z", message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "/work/site/index.html", content: "<h1>hi</h1>" } }], usage: { input_tokens: 5, output_tokens: 3 } } }),
  ].join("\n") + "\n");

  staleFile = join(proj, "stale-uuid.jsonl");
  writeFileSync(staleFile, [
    rec({ type: "user", cwd: "/work/old", timestamp: "2026-07-01T00:00:00.000Z", message: { role: "user" } }),
  ].join("\n") + "\n");

  // Pin mtimes so window filtering is deterministic regardless of wall clock:
  // fresh = 1 minute before NOW, stale = 3 days before NOW.
  utimesSync(freshFile, (NOW - 60_000) / 1000, (NOW - 60_000) / 1000);
  utimesSync(staleFile, (NOW - 3 * 24 * 60 * 60 * 1000) / 1000, (NOW - 3 * 24 * 60 * 60 * 1000) / 1000);
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("listActiveSessions", () => {
  it("returns recently-written transcripts as sessions, newest first", () => {
    const sessions = listActiveSessions({ baseDir: claudeDir, now: NOW, withinMs: 60 * 60 * 1000 });
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    const s = sessions.find((x) => x.file === freshFile);
    expect(s).toBeTruthy();
    expect(s!.id).toBe("fresh-uuid");
    expect(s!.agent).toBe("claude");
    expect(s!.project).toBe("site"); // basename(cwd)
  });

  it("drops sessions whose file mtime is older than the window", () => {
    // 30s window at NOW excludes even the fresh file (written 1 min before NOW).
    const sessions = listActiveSessions({ baseDir: claudeDir, now: NOW, withinMs: 30 * 1000 });
    expect(sessions).toHaveLength(0);
  });

  it("excludes the stale file but keeps the fresh one within a 1h window", () => {
    const sessions = listActiveSessions({ baseDir: claudeDir, now: NOW, withinMs: 60 * 60 * 1000 });
    const files = sessions.map((s) => s.file);
    expect(files).toContain(freshFile);
    expect(files).not.toContain(staleFile);
  });
});

describe("resolveTranscriptFile", () => {
  it("accepts a .jsonl path inside the claude projects root", () => {
    expect(resolveTranscriptFile(freshFile, claudeDir)).toBe(freshFile);
  });
  it("rejects a non-jsonl path", () => {
    expect(resolveTranscriptFile(join(proj, "notes.txt"), claudeDir)).toBeNull();
  });
  it("rejects a path outside every watch root (traversal)", () => {
    expect(resolveTranscriptFile(join(claudeDir, "..", "secret.jsonl"), claudeDir)).toBeNull();
    expect(resolveTranscriptFile("/etc/passwd.jsonl", claudeDir)).toBeNull();
  });
  it("rejects a prefix-sibling of the root", () => {
    const roots = watchRoots(claudeDir);
    expect(resolveTranscriptFile(roots.claudeProjects + "-evil/x.jsonl", claudeDir)).toBeNull();
  });
});

describe("agentForFile", () => {
  it("classifies codex sessions under the codex root", () => {
    const roots = watchRoots(claudeDir);
    expect(agentForFile(join(roots.codexSessions, "rollout-x.jsonl"), claudeDir)).toBe("codex");
    expect(agentForFile(freshFile, claudeDir)).toBe("claude");
  });
});
