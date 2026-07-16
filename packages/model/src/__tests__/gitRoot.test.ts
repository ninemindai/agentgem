// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gitProjectRoot, normalizeProjectRoot } from "../gitRoot.js";

// Real-FS fixtures: a main checkout (.git directory), two linked worktrees
// (.git files with absolute and relative gitdir pointers), and a submodule.
let base: string;
let main: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "agentgem-gitroot-"));
  main = join(base, "main");
  mkdirSync(join(main, ".git"), { recursive: true });
  mkdirSync(join(main, "packages", "web"), { recursive: true });

  const absWt = join(base, "worktrees", "task-abs");
  mkdirSync(join(absWt, "src"), { recursive: true });
  writeFileSync(join(absWt, ".git"), `gitdir: ${join(main, ".git", "worktrees", "task-abs")}\n`);

  const relWt = join(base, "worktrees", "task-rel");
  mkdirSync(relWt, { recursive: true });
  writeFileSync(join(relWt, ".git"), "gitdir: ../../main/.git/worktrees/task-rel\n");

  mkdirSync(join(main, "vendor", "sub"), { recursive: true });
  writeFileSync(join(main, "vendor", "sub", ".git"), "gitdir: ../../.git/modules/sub\n");

  mkdirSync(join(base, "plain"), { recursive: true });
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("gitProjectRoot", () => {
  it("returns the checkout root when .git is a directory", () => {
    expect(gitProjectRoot(main)).toBe(main);
  });

  it("walks up from a subdirectory to the checkout root", () => {
    expect(gitProjectRoot(join(main, "packages", "web"))).toBe(main);
  });

  it("resolves a linked worktree to the main checkout root", () => {
    expect(gitProjectRoot(join(base, "worktrees", "task-abs"))).toBe(main);
  });

  it("resolves a worktree subdirectory to the main checkout root", () => {
    expect(gitProjectRoot(join(base, "worktrees", "task-abs", "src"))).toBe(main);
  });

  it("resolves a relative gitdir pointer against the worktree dir", () => {
    expect(gitProjectRoot(join(base, "worktrees", "task-rel"))).toBe(main);
  });

  it("treats a submodule as its own root (gitdir without /worktrees/)", () => {
    expect(gitProjectRoot(join(main, "vendor", "sub"))).toBe(join(main, "vendor", "sub"));
  });

  it("returns null when no .git exists up the tree", () => {
    expect(gitProjectRoot(join(base, "plain"))).toBeNull();
  });

  it("returns null for a nonexistent path with no git ancestors", () => {
    expect(gitProjectRoot(join(base, "plain", "gone", "deeper"))).toBeNull();
  });
});

describe("normalizeProjectRoot", () => {
  it("maps a worktree path to the main checkout root", () => {
    expect(normalizeProjectRoot(join(base, "worktrees", "task-abs"))).toBe(main);
  });

  it("falls back to the resolved path for non-git dirs", () => {
    expect(normalizeProjectRoot(join(base, "plain"))).toBe(resolve(join(base, "plain")));
  });
});
