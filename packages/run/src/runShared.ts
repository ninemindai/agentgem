// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Shared run machinery: process-runner plumbing, the run registry, and project rendering.
// Split out of run.ts so every consumer of the run state reads/writes the same registry.
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspaceDir, createLogger } from "@agentgem/base";
import { readGemArchive } from "@agentgem/archive";
import { readArchiveDir, writeArchiveDir } from "@agentgem/archive";
import { materialize, type TargetId, type MaterializeOpts } from "@agentgem/model";

export interface ProcHandle {
  onLine(cb: (line: string, stream: "out" | "err") => void): void;
  onExit(cb: (code: number | null) => void): void;
  kill(): void;
}
export interface ProcessRunner {
  spawn(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): ProcHandle;
}

const log = createLogger("run");

export type RunMode = "local" | "vercel" | "cloudflare";
export type RunPhase = "idle" | "installing" | "building" | "running" | "deploying" | "failed";
export interface RunState { mode: RunMode; state: RunPhase; url?: string; logTail: string[] }

const LOG_CAP = 200;
export function pushLog(buf: string[], line: string): string[] {
  buf.push(line);
  if (buf.length > LOG_CAP) buf.splice(0, buf.length - LOG_CAP);
  return buf;
}
export function nodeMajor(version: string): number {
  const m = /^v?(\d+)/.exec(version);
  return m ? Number(m[1]) : 0;
}
export function runReadiness(): { local: boolean } {
  return { local: nodeMajor(process.version) >= 24 };
}
// eve start prints a localhost URL once listening; grab the first http(s) URL.
export function parseEveUrl(lines: string[]): string | undefined {
  for (const l of lines) { const m = /(https?:\/\/[^\s]+)/.exec(l); if (m) return m[1]; }
  return undefined;
}

// Real runner: line-buffer stdout/stderr; deliver whole lines.
export const realRunner: ProcessRunner = {
  spawn(cmd, args, opts) {
    // Command + args + cwd are the first thing you need when a run fails;
    // env is deliberately not logged (it carries tokens). Args are non-secret CLI flags.
    log.debug("spawn: %s %o (cwd=%s)", cmd, args, opts.cwd);
    const child = nodeSpawn(cmd, args, { cwd: opts.cwd, env: opts.env });
    const lineCbs: ((line: string, s: "out" | "err") => void)[] = [];
    const exitCbs: ((code: number | null) => void)[] = [];
    const wire = (stream: NodeJS.ReadableStream | null, which: "out" | "err") => {
      if (!stream) return;
      let buf = "";
      stream.on("data", (d: Buffer) => {
        buf += d.toString();
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); lineCbs.forEach((cb) => cb(line, which)); }
      });
    };
    wire(child.stdout, "out");
    wire(child.stderr, "err");
    child.on("exit", (code) => exitCbs.forEach((cb) => cb(code)));
    child.on("error", (err) => {
      // spawn-level failure (e.g. ENOENT — command not on PATH): previously invisible.
      log.error("spawn failed: %s %o — %s", cmd, args, (err as Error)?.message ?? err);
      exitCbs.forEach((cb) => cb(1));
    });
    return {
      onLine: (cb) => { lineCbs.push(cb); },
      onExit: (cb) => { exitCbs.push(cb); },
      kill: () => { child.kill(); },
    };
  },
};

// Run one command to completion; pipe its lines into `log`; resolve with the exit code.
export function runToEnd(runner: ProcessRunner, cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, log: string[]): Promise<number> {
  return new Promise((resolve) => {
    const h = runner.spawn(cmd, args, { cwd, env });
    h.onLine((line) => pushLog(log, line));
    h.onExit((code) => resolve(code ?? 0));
  });
}

// Re-render <target> into a stable .run/<target> dir (preserving node_modules) and npm-install when needed.
export async function ensureRunProject(name: string, target: TargetId, runner: ProcessRunner, log: string[], opts: MaterializeOpts = {}): Promise<string> {
  const dir = workspaceDir(name);
  if (!existsSync(join(dir, "gem.json"))) throw new Error(`no workspace '${name}'`);
  const gem = readGemArchive(readArchiveDir(dir));
  const { files } = materialize(gem, target, opts);
  const runDir = target === "eve" ? join(dir, ".run", vercelProject(name)) : join(dir, ".run", target);
  mkdirSync(runDir, { recursive: true });
  // Drop stale rendered sources + build caches; keep node_modules + the install marker.
  for (const entry of readdirSync(runDir)) {
    if (entry === "node_modules" || entry === ".installed-package.json") continue;
    rmSync(join(runDir, entry), { recursive: true, force: true });
  }
  writeArchiveDir(runDir, files);
  const pkg = readFileSync(join(runDir, "package.json"), "utf8");
  const marker = join(runDir, ".installed-package.json");
  const installed = existsSync(marker) ? readFileSync(marker, "utf8") : "";
  if (!existsSync(join(runDir, "node_modules")) || installed !== pkg) {
    const code = await runToEnd(runner, "npm", ["install", "--no-audit", "--no-fund"], runDir, process.env, log);
    if (code !== 0) throw new Error("npm install failed");
    writeFileSync(marker, pkg, "utf8");
  }
  return runDir;
}

// Per-gem eve run-dir name: eve-<slug(name)>. Slug = lowercase, non-alnum→'-', trimmed.
// The rendered project's dir basename doubles as its hosting project name, so keep it stable.
export const vercelProject = (name: string) =>
  "eve-" + (name.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent");

export const registry = new Map<string, { state: RunState; handle?: ProcHandle }>();
export const EVE_BIN = (runDir: string) => join(runDir, "node_modules", ".bin", "eve");
