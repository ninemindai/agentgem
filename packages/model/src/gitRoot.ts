// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gitRoot.ts
//
// Project identity is the git checkout, not the session cwd. Sessions run in
// subdirectories and (heavily, per this repo's own workflow) in linked git
// worktrees; keying "project" on the raw cwd fragments one repo's activity
// across every worktree path. These resolvers walk up to the containing
// checkout and, for linked worktrees, follow the `gitdir:` pointer back to the
// main checkout — no `git` subprocess, just a few statSync calls per lookup.
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// A linked worktree's `.git` is a FILE holding `gitdir: <main>/.git/worktrees/<name>`
// (git's own common-dir discovery). A submodule's pointer targets `.git/modules/…`
// instead, so it deliberately does NOT match — a submodule is its own project.
const WORKTREE_GITDIR_RE = /^(.*)[/\\]\.git[/\\]worktrees[/\\][^/\\]+$/;

function statSafe(p: string): import("node:fs").Stats | undefined {
  try { return statSync(p); } catch { return undefined; }
}

/** The main-checkout root containing `dir`, or null when `dir` is not inside a
 *  git checkout (including when it no longer exists on disk). */
export function gitProjectRoot(dir: string): string | null {
  let cur = resolve(dir);
  for (;;) {
    const marker = join(cur, ".git");
    const st = statSafe(marker);
    if (st?.isDirectory()) return cur;
    if (st?.isFile()) {
      let text: string;
      try { text = readFileSync(marker, "utf8"); } catch { return cur; }
      const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(text);
      const target = pointer ? WORKTREE_GITDIR_RE.exec(resolve(cur, pointer[1])) : null;
      return target ? target[1] : cur;
    }
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/** Canonical project key for a session cwd / picked path: the containing git
 *  checkout when there is one, the resolved path itself otherwise. */
export function normalizeProjectRoot(p: string): string {
  return gitProjectRoot(p) ?? resolve(p);
}
