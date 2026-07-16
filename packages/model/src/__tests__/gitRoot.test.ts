// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gitProjectRoot, normalizeProjectRoot, makeProjectRootNormalizer } from "../gitRoot.js";

// Real-FS fixtures modeled on how git actually lays out a linked worktree: the
// main checkout's `.git/worktrees/<name>` administrative dir MUST exist for the
// pointer to be trusted (a `.git` file pointing at a nonexistent target is not a
// real worktree — see the "forged pointer" tests below).
let base: string;
let main: string;

function realWorktree(dir: string, name: string, gitdir: string): void {
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(main, ".git", "worktrees", name), { recursive: true });
  writeFileSync(join(dir, ".git"), `gitdir: ${gitdir}\n`);
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "agentgem-gitroot-"));
  main = join(base, "main");
  mkdirSync(join(main, ".git"), { recursive: true });
  mkdirSync(join(main, "packages", "web"), { recursive: true });

  const absWt = join(base, "worktrees", "task-abs");
  mkdirSync(join(absWt, "src"), { recursive: true });
  realWorktree(absWt, "task-abs", join(main, ".git", "worktrees", "task-abs"));

  const relWt = join(base, "worktrees", "task-rel");
  realWorktree(relWt, "task-rel", "../../main/.git/worktrees/task-rel");

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

  // --- hardening: an on-disk `.git` file is untrusted content ---

  it("does NOT fold a forged pointer whose worktree gitdir does not exist", () => {
    const evil = join(base, "evil");
    mkdirSync(evil, { recursive: true });
    writeFileSync(join(evil, ".git"), `gitdir: ${join(base, "nowhere", ".git", "worktrees", "x")}\n`);
    expect(gitProjectRoot(evil)).toBe(evil); // treated as its own root, not "base/nowhere"
  });

  it("ignores a gitdir: line that is not the first line of the .git file", () => {
    const dir = join(base, "buried");
    mkdirSync(join(main, ".git", "worktrees", "buried"), { recursive: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".git"), `junk\ngitdir: ${join(main, ".git", "worktrees", "buried")}\n`);
    expect(gitProjectRoot(dir)).toBe(dir); // git always writes gitdir: first; a buried line is not a pointer
  });

  it("refuses an oversized .git file even with a valid first-line pointer", () => {
    const dir = join(base, "huge");
    mkdirSync(join(main, ".git", "worktrees", "huge"), { recursive: true });
    mkdirSync(dir, { recursive: true });
    const pad = "x".repeat(64 * 1024);
    writeFileSync(join(dir, ".git"), `gitdir: ${join(main, ".git", "worktrees", "huge")}\n${pad}`);
    expect(gitProjectRoot(dir)).toBe(dir); // an outsized "pointer" file is not a real worktree
  });

  it("treats a .git file with no gitdir: line as its own root", () => {
    const dir = join(base, "notpointer");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".git"), "this is not a gitdir pointer\n");
    expect(gitProjectRoot(dir)).toBe(dir);
  });
});

describe("gitProjectRoot home boundary", () => {
  let prevHome: string | undefined;
  let home: string;

  beforeAll(() => {
    prevHome = process.env.HOME;
    home = join(base, "fakehome");
    mkdirSync(join(home, ".git"), { recursive: true }); // a dotfiles-style `git init $HOME`
    mkdirSync(join(home, "notes"), { recursive: true });
    process.env.HOME = home;
  });
  afterAll(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  });

  it("does not fold a non-git dir under $HOME up to $HOME", () => {
    expect(gitProjectRoot(join(home, "notes"))).toBeNull();
  });

  it("does not treat $HOME itself as a project root", () => {
    expect(gitProjectRoot(home)).toBeNull();
  });
});

describe("makeProjectRootNormalizer", () => {
  it("memoizes: repeated lookups of the same path return one result", () => {
    const norm = makeProjectRootNormalizer();
    const p = join(base, "worktrees", "task-abs");
    expect(norm(p)).toBe(main);
    expect(norm(p)).toBe(main); // second call served from memo, same answer
  });

  it("matches normalizeProjectRoot for distinct paths", () => {
    const norm = makeProjectRootNormalizer();
    expect(norm(join(base, "plain"))).toBe(normalizeProjectRoot(join(base, "plain")));
    expect(norm(main)).toBe(main);
  });
});
