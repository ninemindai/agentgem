// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/sessionBlastCore.ts
//
// Per-session blast radius: resolve one session (Claude or Codex) and scan its
// transcript into the ordered, scrubbed touch-event series for Inspect → Session.
// Mirrors sessionHygieneCore: guard failures are tagged so the controller maps
// exactly these to a 400 and unexpected faults stay 500s (no echoed paths).
//
// Observed commit SHAs are reconciled against git here (the one place that still
// holds the raw session cwd): each commit gets the cwd-relative files it shipped,
// or keeps `files` absent when git can no longer resolve it — never a guess.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  scanSessionBlast, scanCodexSessionBlast, resolveClaudeSession, resolveCodexSession,
  type BlastReport,
} from "@agentgem/insight";

export class BlastInputError extends Error {}

export type GitRun = (args: string[]) => Promise<string>;

const execFileP = promisify(execFile);
const gitIn = (cwd: string): GitRun => async (args) => {
  const { stdout } = await execFileP("git", ["-C", cwd, ...args], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
};

// The SHA came out of transcript content (untrusted); re-validate before it
// reaches a git argv even though execFile never touches a shell.
const SHA_RE = /^[0-9a-f]{7,40}$/;

/** Attach the files each observed commit touched, cwd-relative. Evidence-bounded:
 *  a commit git cannot resolve (repo moved on, sha gone, cwd not a repo) keeps
 *  `files` absent; files outside the cwd's repo prefix keep their repo-relative
 *  path (they simply won't match a blast target). */
export async function attachCommitFiles(rep: BlastReport, cwd: string, run: GitRun = gitIn(cwd)): Promise<BlastReport> {
  if (rep.commits.length === 0) return rep;
  let prefix: string;
  try { prefix = (await run(["rev-parse", "--show-prefix"])).trim(); }
  catch { return rep; }
  const commits = await Promise.all(rep.commits.map(async (c) => {
    if (!SHA_RE.test(c.sha)) return c;
    try {
      const out = await run(["show", "--name-only", "--format=", c.sha]);
      const files = out.split("\n").map((l) => l.trim()).filter(Boolean)
        .map((f) => (prefix && f.startsWith(prefix) ? f.slice(prefix.length) : f));
      return { ...c, files };
    } catch { return c; }
  }));
  return { ...rep, commits };
}

export async function sessionBlast(id: string, agent: string): Promise<BlastReport> {
  if (agent === "claude") {
    const found = await resolveClaudeSession(id);
    if (!found) throw new BlastInputError(`No Claude session '${id}' found.`);
    const text = await readFile(found.path, "utf8");
    const rep = scanSessionBlast(text, { cwd: found.cwd, sessionId: id, transcript: basename(found.path) });
    return found.cwd ? attachCommitFiles(rep, found.cwd) : rep;
  }
  if (agent === "codex") {
    const found = await resolveCodexSession(id);
    if (!found) throw new BlastInputError(`No Codex session '${id}' found.`);
    const text = await readFile(found.path, "utf8");
    const rep = scanCodexSessionBlast(text, { cwd: found.cwd, sessionId: id, transcript: basename(found.path) });
    return found.cwd ? attachCommitFiles(rep, found.cwd) : rep;
  }
  throw new BlastInputError(`Blast radius is not available for agent '${agent}'.`);
}
