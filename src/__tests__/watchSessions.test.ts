import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listActiveSessions, createSessionLister, resolveTranscriptFile, agentForFile, sourceForFile } from "@agentgem/app/watchSessions";
import { resolveDirs } from "@agentgem/model";

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
    const claudeProjects = join(claudeDir, "projects");
    expect(resolveTranscriptFile(claudeProjects + "-evil/x.jsonl", claudeDir)).toBeNull();
  });
});

describe("sourceForFile / agentForFile", () => {
  it("classifies claude and codex transcripts by their registered roots", () => {
    const codexSessions = join(resolveDirs(claudeDir).codexDir, "sessions");
    expect(agentForFile(join(codexSessions, "rollout-x.jsonl"), claudeDir)).toBe("codex");
    expect(agentForFile(freshFile, claudeDir)).toBe("claude");
    expect(sourceForFile(freshFile, claudeDir)?.detectArtifacts).toBeTruthy(); // claude → transcript-driven
    expect(sourceForFile(join(codexSessions, "rollout-x.jsonl"), claudeDir)?.resolveArtifactPaths).toBeTruthy(); // codex → file-driven
  });
  it("returns null for an out-of-scope path", () => {
    expect(agentForFile("/etc/passwd.jsonl", claudeDir)).toBeNull();
    expect(sourceForFile("/etc/passwd.jsonl", claudeDir)).toBeNull();
  });
});

describe("createSessionLister", () => {
  it("matches listActiveSessions output on a fresh cache", () => {
    const list = createSessionLister();
    const cached = list({ baseDir: claudeDir, now: NOW, withinMs: 60 * 60 * 1000 });
    const plain = listActiveSessions({ baseDir: claudeDir, now: NOW, withinMs: 60 * 60 * 1000 });
    expect(cached).toEqual(plain);
  });

  it("ageMs stays live on cache hits", () => {
    const list = createSessionLister();
    list({ baseDir: claudeDir, now: NOW, withinMs: 60 * 60 * 1000 });
    const later = list({ baseDir: claudeDir, now: NOW + 10_000, withinMs: 60 * 60 * 1000 });
    expect(later.find((s) => s.file === freshFile)!.ageMs).toBe(70_000); // 60s old + 10s later
  });

  // Mutates freshFile — keep this test LAST in the file.
  it("serves cached meta while the mtime is unchanged, refreshes when it moves", () => {
    const list = createSessionLister();
    const before = list({ baseDir: claudeDir, now: NOW, withinMs: 60 * 60 * 1000 });
    const s0 = before.find((s) => s.file === freshFile)!;

    // Append a record but pin the mtime back — a cached lister must NOT re-read.
    appendFileSync(freshFile, rec({ type: "user", cwd: "/work/site", timestamp: "2026-07-03T11:59:40.000Z", message: { role: "user", content: "more" } }) + "\n");
    utimesSync(freshFile, (NOW - 60_000) / 1000, (NOW - 60_000) / 1000);
    const stale = list({ baseDir: claudeDir, now: NOW, withinMs: 60 * 60 * 1000 });
    expect(stale.find((s) => s.file === freshFile)!.msgs).toBe(s0.msgs);

    // Bump the mtime — the lister re-parses and sees the appended record.
    utimesSync(freshFile, (NOW - 30_000) / 1000, (NOW - 30_000) / 1000);
    const fresh = list({ baseDir: claudeDir, now: NOW, withinMs: 60 * 60 * 1000 });
    expect(fresh.find((s) => s.file === freshFile)!.msgs).toBeGreaterThan(s0.msgs);
  });
});
