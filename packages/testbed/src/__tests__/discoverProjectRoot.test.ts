// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverProjects } from "../testbedFlavors.js";

// Discovery feeds the Mine project picker (and the project-root allow-list).
// Sessions run in git worktrees must collapse into one entry for the main
// checkout — one project per repo, newest session wins the recency slot.
let base: string;
let main: string;
let worktree: string;
let claudeDir: string;

function writeSession(folder: string, cwd: string, mtime: Date): void {
  const dir = join(claudeDir, "projects", folder);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "session.jsonl");
  writeFileSync(path, JSON.stringify({ type: "user", timestamp: mtime.toISOString(), cwd, message: { content: "hi" } }) + "\n");
  utimesSync(path, mtime, mtime);
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "agentgem-discover-root-"));
  main = join(base, "shiny-repo");
  mkdirSync(join(main, ".git"), { recursive: true });
  worktree = join(base, "shiny-repo-worktrees", "task");
  mkdirSync(worktree, { recursive: true });
  mkdirSync(join(main, ".git", "worktrees", "task"), { recursive: true });
  writeFileSync(join(worktree, ".git"), `gitdir: ${join(main, ".git", "worktrees", "task")}\n`);
  claudeDir = join(base, ".claude");
  writeSession("p-main", main, new Date("2026-07-01T00:00:00Z"));
  writeSession("p-wt", worktree, new Date("2026-07-10T00:00:00Z"));
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("discoverProjects folds worktrees into the main checkout", () => {
  it("returns one candidate at the main root carrying the newest session's recency", () => {
    const dirs = { claudeDir, agentDir: join(base, ".agents"), codexDir: join(base, ".codex"), hermesDir: join(base, ".hermes") };
    const got = discoverProjects(dirs);
    expect(got).toHaveLength(1);
    expect(got[0].path).toBe(main);
    expect(got[0].lastUsed).toBe("2026-07-10T00:00:00.000Z");
    expect(got[0].exists).toBe(true);
  });
});
