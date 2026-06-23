// src/gem/run.ts
// Run/deploy the rendered eve project. Side-effecting orchestration (peer of workspaces.ts).
// Process spawning is injected via ProcessRunner so command/env/state logic is unit-testable.
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspaceDir } from "./workspaces.js";
import { readGemArchive } from "./archive.js";
import { readArchiveDir, writeArchiveDir } from "./archiveFs.js";
import { materialize, type TargetId } from "./targets.js";

export interface ProcHandle {
  onLine(cb: (line: string, stream: "out" | "err") => void): void;
  onExit(cb: (code: number | null) => void): void;
  kill(): void;
}
export interface ProcessRunner {
  spawn(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): ProcHandle;
}

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
export function runReadiness(): { local: boolean; vercel: boolean; cloudflare: boolean } {
  return { local: nodeMajor(process.version) >= 24, vercel: !!process.env.VERCEL_TOKEN, cloudflare: !!process.env.CLOUDFLARE_API_TOKEN };
}
// eve start prints a localhost URL once listening; grab the first http(s) URL.
export function parseEveUrl(lines: string[]): string | undefined {
  for (const l of lines) { const m = /(https?:\/\/[^\s]+)/.exec(l); if (m) return m[1]; }
  return undefined;
}
// vercel deploy prints the deployment URL (a bare https://<id>.vercel.app line).
export function parseVercelUrl(lines: string[]): string | undefined {
  for (const l of lines) { const m = /(https:\/\/[^\s]+\.vercel\.app[^\s]*)/.exec(l); if (m) return m[1]; }
  return undefined;
}
// When `vercel deploy` runs non-interactively under a token whose account has teams, the CLI
// refuses with a structured "missing_scope" response listing the available teams. If there is
// exactly ONE team, return its name so we can retry with --scope; otherwise undefined (ambiguous).
export function parseSingleTeamScope(lines: string[]): string | undefined {
  const text = lines.join("\n");
  if (!/missing_scope|action_required/.test(text)) return undefined;
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    const choices = Array.isArray(obj.choices) ? obj.choices : [];
    if (choices.length === 1 && typeof choices[0].name === "string") return choices[0].name;
  } catch { /* not the structured response */ }
  return undefined;
}
// wrangler prints the deployed Worker URL (https://<name>.<acct>.workers.dev).
export function parseWorkersUrl(lines: string[]): string | undefined {
  for (const l of lines) { const m = /(https:\/\/[^\s]+\.workers\.dev[^\s]*)/.exec(l); if (m) return m[1]; }
  return undefined;
}

// Real runner: line-buffer stdout/stderr; deliver whole lines.
export const realRunner: ProcessRunner = {
  spawn(cmd, args, opts) {
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
    child.on("error", () => exitCbs.forEach((cb) => cb(1)));
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
export async function ensureRunProject(name: string, target: TargetId, runner: ProcessRunner, log: string[]): Promise<string> {
  const dir = workspaceDir(name);
  if (!existsSync(join(dir, "gem.json"))) throw new Error(`no workspace '${name}'`);
  const gem = readGemArchive(readArchiveDir(dir));
  const { files } = materialize(gem, target);
  const runDir = join(dir, ".run", target);
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

const registry = new Map<string, { state: RunState; handle?: ProcHandle }>();
const EVE_BIN = (runDir: string) => join(runDir, "node_modules", ".bin", "eve");

export async function startLocal(name: string, runner: ProcessRunner = realRunner): Promise<RunState> {
  for (const e of registry.values()) {
    if (e.state.mode === "local" && e.state.state === "running") throw new Error("a local run is already active");
  }
  const state: RunState = { mode: "local", state: "installing", logTail: [] };
  registry.set(`${name}:eve`, { state });
  try {
    const runDir = await ensureRunProject(name, "eve", runner, state.logTail);
    state.state = "building";
    const buildCode = await runToEnd(runner, EVE_BIN(runDir), ["build"], runDir, process.env, state.logTail);
    if (buildCode !== 0) { state.state = "failed"; return state; }
    const handle = runner.spawn(EVE_BIN(runDir), ["start"], { cwd: runDir, env: process.env });
    registry.set(`${name}:eve`, { state, handle });
    state.state = "running";
    handle.onLine((line) => {
      pushLog(state.logTail, line);
      if (!state.url) { const u = parseEveUrl([line]); if (u) state.url = u; }
    });
    handle.onExit((code) => { if (state.state === "running") state.state = code === 0 ? "idle" : "failed"; });
    return state;
  } catch (err) {
    state.state = "failed";
    pushLog(state.logTail, err instanceof Error ? err.message : String(err));
    return state;
  }
}

export function stopLocal(name: string, target: string): { stopped: boolean } {
  const e = registry.get(`${name}:${target}`);
  if (!e?.handle) return { stopped: false };
  e.handle.kill();
  e.state.state = "idle";
  return { stopped: true };
}

export function getRunStatus(name: string, target: string): RunState {
  return registry.get(`${name}:${target}`)?.state ?? { mode: "local", state: "idle", logTail: [] };
}

const binIn = (runDir: string, name: string) => join(runDir, "node_modules", ".bin", name);

// agentgem's own pinned vercel CLI (installed as a dependency), run with cwd = the eve run dir.
const VERCEL_BIN = join(process.cwd(), "node_modules", ".bin", "vercel");

// Deploy the eve project to Vercel from SOURCE (not --prebuilt): eve warns that a local prebuilt
// build skips Vercel sandbox-template prewarm, so Vercel must build it. Scope: use VERCEL_SCOPE if
// set, else deploy without scope and — when the CLI refuses with a single available team — retry
// with --scope <that team>.
export async function deployVercel(name: string, runner: ProcessRunner = realRunner): Promise<RunState> {
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw new Error("VERCEL_TOKEN is not set on the server — cannot deploy to Vercel.");
  const state: RunState = { mode: "vercel", state: "installing", logTail: [] };
  registry.set(`${name}:eve`, { state });
  const vercelDeploy = (runDir: string, scope?: string) => {
    const args = ["deploy", "--yes", `--token=${token}`, ...(scope ? [`--scope=${scope}`] : [])];
    const lines: string[] = [];
    return new Promise<{ code: number; lines: string[] }>((resolve) => {
      const h = runner.spawn(VERCEL_BIN, args, { cwd: runDir, env: process.env });
      h.onLine((line) => { pushLog(state.logTail, line); lines.push(line); });
      h.onExit((c) => resolve({ code: c ?? 0, lines }));
    });
  };
  try {
    const runDir = await ensureRunProject(name, "eve", runner, state.logTail);
    state.state = "deploying";
    const explicitScope = process.env.VERCEL_SCOPE;
    let { code, lines } = await vercelDeploy(runDir, explicitScope);
    if (code !== 0 && !explicitScope) {
      const team = parseSingleTeamScope(lines);
      if (team) { pushLog(state.logTail, `↻ retrying with --scope ${team}`); ({ code, lines } = await vercelDeploy(runDir, team)); }
    }
    if (code !== 0) { state.state = "failed"; return state; }
    state.url = parseVercelUrl(lines);
    state.state = "idle";
    return state;
  } catch (err) {
    state.state = "failed";
    pushLog(state.logTail, err instanceof Error ? err.message : String(err));
    return state;
  }
}

export async function deployCloudflare(name: string, runner: ProcessRunner = realRunner): Promise<RunState> {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN is not set on the server — cannot deploy to Cloudflare.");
  const state: RunState = { mode: "cloudflare", state: "installing", logTail: [] };
  registry.set(`${name}:flue`, { state });
  try {
    const runDir = await ensureRunProject(name, "flue", runner, state.logTail);
    state.state = "building";
    const buildCode = await runToEnd(runner, binIn(runDir, "flue"), ["build", "--target", "cloudflare"], runDir, process.env, state.logTail);
    if (buildCode !== 0) { state.state = "failed"; return state; }
    state.state = "deploying";
    const lines: string[] = [];
    const env = { ...process.env, CLOUDFLARE_API_TOKEN: token };
    const code = await new Promise<number>((resolve) => {
      const h = runner.spawn(binIn(runDir, "wrangler"), ["deploy"], { cwd: runDir, env });
      h.onLine((line) => { pushLog(state.logTail, line); lines.push(line); });
      h.onExit((c) => resolve(c ?? 0));
    });
    if (code !== 0) { state.state = "failed"; return state; }
    state.url = parseWorkersUrl(lines);
    state.state = "idle";
    return state;
  } catch (err) {
    state.state = "failed";
    pushLog(state.logTail, err instanceof Error ? err.message : String(err));
    return state;
  }
}
