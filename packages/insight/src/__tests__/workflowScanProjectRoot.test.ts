// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeTranscriptsForCwd, bucketTranscriptsByCwd } from "../workflowScan.js";

// The scorecard/optimize paths map a project root to its transcripts by cwd.
// Sessions run in worktrees/subdirectories must count toward the main checkout.
let base: string;
let main: string;
let worktree: string;
let claudeDir: string;
let mainSession: string;
let worktreeSession: string;
let otherSession: string;

function writeSession(folder: string, name: string, cwd: string): string {
  const dir = join(claudeDir, "projects", folder);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:00Z", cwd, message: { content: "hi" } }) + "\n");
  return path;
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "agentgem-wfscan-root-"));
  main = join(base, "shiny-repo");
  mkdirSync(join(main, ".git"), { recursive: true });
  worktree = join(base, "shiny-repo-worktrees", "task");
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, ".git"), `gitdir: ${join(main, ".git", "worktrees", "task")}\n`);
  claudeDir = join(base, ".claude");
  mainSession = writeSession("p-main", "s1.jsonl", main);
  worktreeSession = writeSession("p-wt", "s2.jsonl", worktree);
  otherSession = writeSession("p-other", "s3.jsonl", join(base, "elsewhere"));
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("transcript↔project matching normalizes to the git checkout", () => {
  it("claudeTranscriptsForCwd on the main root includes worktree sessions", () => {
    const got = claudeTranscriptsForCwd(claudeDir, main).sort();
    expect(got).toEqual([mainSession, worktreeSession].sort());
  });

  it("bucketTranscriptsByCwd buckets worktree sessions under the main root", () => {
    const bucket = bucketTranscriptsByCwd(claudeDir);
    expect(bucket.get(main)?.sort()).toEqual([mainSession, worktreeSession].sort());
    expect(bucket.get(join(base, "elsewhere"))).toEqual([otherSession]);
  });
});
