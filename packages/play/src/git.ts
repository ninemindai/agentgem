// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// A thin child_process git wrapper for the local miniapps registry. No dependency; git must be on
// PATH. Commits carry a fixed local identity so they work headless/in CI (a user can re-attribute).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn("git", args, { cwd });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => { stdout += d; });
    p.stderr.on("data", (d) => { stderr += d; });
    p.on("error", (e) => reject(new Error(`git not available on PATH: ${(e as Error).message}`)));
    p.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

async function run(cwd: string, args: string[]): Promise<string> {
  const r = await git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout.trim();
}

export async function ensureRepo(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  if (existsSync(join(dir, ".git"))) return;
  await run(dir, ["init", "-q"]);
  // fixed local identity so commits succeed without global git config (CI/headless)
  await run(dir, ["config", "user.name", "AgentGem"]);
  await run(dir, ["config", "user.email", "miniapps@agentgem.local"]);
}

export async function commitAll(dir: string, message: string): Promise<string | null> {
  await run(dir, ["add", "-A"]);
  const status = await run(dir, ["status", "--porcelain"]);
  if (status === "") return null; // nothing staged/changed
  await run(dir, ["commit", "-q", "-m", message]);
  return run(dir, ["rev-parse", "HEAD"]);
}

export async function setRemote(dir: string, url: string): Promise<void> {
  const remotes = await run(dir, ["remote"]);
  if (remotes.split("\n").includes("origin")) await run(dir, ["remote", "set-url", "origin", url]);
  else await run(dir, ["remote", "add", "origin", url]);
}

export async function push(dir: string): Promise<void> {
  await run(dir, ["push", "-u", "origin", "HEAD"]);
}
