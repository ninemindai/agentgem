// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useHermeticHome } from "../../__tests__/support/hermeticHome.js";
import { resolveAllowedProjectRoot } from "../projectRoots.js";

// The allow-list is discovered ∪ recent projects, now normalized to git
// checkouts. A caller may still hand in a raw worktree path (stale UI state,
// recents) — it must resolve to the allow-listed main root, never escape it.
let restoreHome: () => void;
let home: string;
let main: string;
let worktree: string;

beforeAll(() => {
  restoreHome = useHermeticHome();
  home = process.env.HOME!;
  main = join(home, "repos", "shiny-repo");
  mkdirSync(join(main, ".git"), { recursive: true });
  worktree = join(home, "repos", "shiny-repo-worktrees", "task");
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, ".git"), `gitdir: ${join(main, ".git", "worktrees", "task")}\n`);
  // One discovered session, run in the WORKTREE — the allow-list entry becomes the main root.
  const sessions = join(home, ".claude", "projects", "p1");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "s1.jsonl"), JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:00Z", cwd: worktree, message: { content: "hi" } }) + "\n");
});

afterAll(() => restoreHome());

describe("resolveAllowedProjectRoot", () => {
  it("allows the main checkout root discovered via a worktree session", () => {
    expect(resolveAllowedProjectRoot(main)).toBe(main);
  });

  it("folds a raw worktree path to the allow-listed main root", () => {
    expect(resolveAllowedProjectRoot(worktree)).toBe(main);
  });

  it("still rejects paths outside the allow-list", () => {
    expect(resolveAllowedProjectRoot(join(home, "elsewhere"))).toBeNull();
  });
});
