// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Local install for a Discover recommendation: shell out to the `skills` CLI
// (the package is CLI-only — no library entry, and it calls process.exit() on
// import, so it cannot be required in-process). We run the exact command we also
// show users to copy: `npx skills add <source>@<id>`, forced to --global so it
// installs into the user's own agent skill dirs (~/.agents/skills + symlinks into
// ~/.claude/skills etc.) rather than treating the server's repo as a project, and
// --yes/-y for non-interactive execution. Never throws: any failure resolves to
// { ok:false }, matching the rest of Discover's degrade-don't-crash posture.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";

const execFileP = promisify(execFile);

// Strict refs. execFile args are not shell-interpreted, but validating here rejects
// garbage early and is defense-in-depth against argument-injection-style inputs.
const SOURCE_RE = /^[\w.-]+\/[\w.-]+$/; // owner/repo
const ID_RE = /^[\w.-]+$/;             // skill slug

export type InstallRun = (args: string[]) => Promise<{ stdout: string; stderr: string }>;
export interface InstallResult { ok: boolean; skill: string; message: string }

// `npx` is the fixed binary; args carry the skills subcommand. cwd=homedir so the
// CLI's project auto-detection can't latch onto the server's checkout (belt to the
// --global suspenders). 2-minute cap covers the git clone the CLI does.
const defaultRun: InstallRun = async (args) => {
  const { stdout, stderr } = await execFileP("npx", args, { cwd: homedir(), timeout: 120_000, maxBuffer: 1 << 20 });
  return { stdout, stderr };
};

// Strip ANSI escapes + carriage-return spinner redraws + npm notices, keep the
// last few meaningful lines so the UI shows a readable result, not a wall of noise.
function clean(raw: string): string {
  const noAnsi = raw.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\r/g, "\n");
  const lines = noAnsi.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("npm notice"));
  return lines.slice(-8).join("\n").slice(0, 800);
}

export async function installSkill(
  source: string,
  skillId: string,
  opts: { run?: InstallRun } = {},
): Promise<InstallResult> {
  const skill = `${source}@${skillId}`;
  // Reject "." traversal segments explicitly — the charset class allows dots, so
  // "../etc" would otherwise read as a valid owner/repo.
  const bad = !SOURCE_RE.test(source) || !ID_RE.test(skillId) || source.includes("..") || skillId.includes("..");
  if (bad) {
    return { ok: false, skill, message: "invalid skill reference" };
  }
  const run = opts.run ?? defaultRun;
  const args = ["-y", "skills", "add", skill, "--global", "--yes"];
  try {
    const { stdout, stderr } = await run(args);
    return { ok: true, skill, message: clean(stdout || stderr) || `installed ${skill}` };
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    return { ok: false, skill, message: clean(err.stderr || err.stdout || err.message || "install failed") || "install failed" };
  }
}
