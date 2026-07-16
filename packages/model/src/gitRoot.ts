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
//
// A `.git` FILE is untrusted on-disk content (an archive/tarball can plant one
// that git itself would never write), and one consumer — resolveAllowedProjectRoot
// — turns the resolved root into a filesystem-access allow-list decision. So the
// pointer is validated, not merely parsed: read bounded, gitdir: must be the first
// line, and the worktree's admin dir must actually exist before we fold.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// A linked worktree's `.git` is a FILE holding `gitdir: <main>/.git/worktrees/<name>`
// (git's own common-dir discovery). A submodule's pointer targets `.git/modules/…`
// instead, so it deliberately does NOT match — a submodule is its own project.
const WORKTREE_GITDIR_RE = /^(.*)[/\\]\.git[/\\]worktrees[/\\][^/\\]+$/;
// git's `.git` pointer files are a single short line; anything larger is not one.
const GIT_FILE_MAX_BYTES = 4096;

function statSafe(p: string): import("node:fs").Stats | undefined {
  try { return statSync(p); } catch { return undefined; }
}

/** The main-checkout root containing `dir`, or null when `dir` is not inside a
 *  git checkout (including when it no longer exists on disk). The walk stops at
 *  the home directory: a stray `git init $HOME` must not make every path under
 *  home fold into one home-rooted project (and thereby widen the allow-list). */
export function gitProjectRoot(dir: string): string | null {
  const home = homedir();
  let cur = resolve(dir);
  for (;;) {
    if (cur === home) return null;         // never fold to / treat $HOME as a project root
    const marker = join(cur, ".git");
    const st = statSafe(marker);
    if (st?.isDirectory()) return cur;
    if (st?.isFile()) return worktreeRootFromGitFile(cur, marker, st.size);
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

// Resolve the main-checkout root a worktree `.git` FILE points at, or `cur`
// itself when the file is not a trustworthy worktree pointer (submodule,
// forged/nonexistent target, non-pointer text, oversized, or unreadable).
function worktreeRootFromGitFile(cur: string, marker: string, size: number): string {
  if (size > GIT_FILE_MAX_BYTES) return cur;
  let text: string;
  try { text = readFileSync(marker, "utf8"); } catch { return cur; }
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const m = /^gitdir: *(.+?) *$/.exec(firstLine);     // git writes gitdir: as the first line
  if (!m) return cur;
  const gitdir = resolve(cur, m[1]);
  const wt = WORKTREE_GITDIR_RE.exec(gitdir);
  if (!wt) return cur;
  // A real worktree's admin dir exists on disk; a planted pointer to a path the
  // attacker doesn't own cannot satisfy this, so it can't inject a project root.
  if (!statSafe(gitdir)?.isDirectory()) return cur;
  return wt[1];
}

/** Canonical project key for a session cwd / picked path: the containing git
 *  checkout when there is one, the resolved path itself otherwise. */
export function normalizeProjectRoot(p: string): string {
  return gitProjectRoot(p) ?? resolve(p);
}

/** A `normalizeProjectRoot` that memoizes within one caller's lifetime. Sessions
 *  share few distinct cwds, and each distinct one costs a handful of statSync
 *  calls; a per-scan/per-request instance amortizes that without a module-level
 *  cache (whose staleness would matter for the allow-list gate). */
export function makeProjectRootNormalizer(): (p: string) => string {
  const memo = new Map<string, string>();
  return (p) => {
    let root = memo.get(p);
    if (root === undefined) { root = normalizeProjectRoot(p); memo.set(p, root); }
    return root;
  };
}
