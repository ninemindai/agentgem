// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Adapter provisioning: turn a bare AgentDescriptor into an absolute launch plan
// by resolving one of three sources — on PATH, the app-managed dir, or (desktop)
// the bundled dir — and install a missing one on demand (CLI only). All fs/PATH
// access goes through injected probes so the logic is unit-testable without a real
// filesystem, npm, or adapter binary.
import { execFileSync, spawn as spawnChild } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentDescriptor } from "./acpSession.js";

export type AdapterRuntime = "cli" | "desktop";

export interface AdapterCtx {
  runtime: AdapterRuntime;
  execPath: string;          // node (cli) or electron (desktop)
  home: string;              // os.homedir()
  resourcesPath?: string;    // desktop: process.resourcesPath
  onPath?: (bin: string) => boolean;
  exists?: (p: string) => boolean;
  readJson?: (p: string) => unknown;
}

export type AdapterSource = "path" | "managed" | "bundled" | "missing";
export interface ResolvedSource { source: AdapterSource; binOnPath?: string; entry?: string }

export function managedAdapterDir(home: string, id: string): string {
  return join(home, ".agentgem", "adapters", id);
}
export function bundledAdapterDir(resourcesPath: string, id: string): string {
  return join(resourcesPath, "adapters", id);
}

function onPathDefault(bin: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Detect the runtime context from `process` (overridable for tests). Electron's
// main process (which hosts the desktop core in-process) sets process.versions.electron
// and process.resourcesPath; a plain CLI has neither.
export function adapterRuntimeCtx(proc: Partial<AdapterCtx> & { versionsElectron?: string } = {}): AdapterCtx {
  const isDesktop = proc.runtime ? proc.runtime === "desktop" : Boolean(proc.versionsElectron ?? process.versions.electron);
  return {
    runtime: isDesktop ? "desktop" : "cli",
    execPath: proc.execPath ?? process.execPath,
    home: proc.home ?? homedir(),
    resourcesPath: proc.resourcesPath ?? (process as { resourcesPath?: string }).resourcesPath,
    onPath: proc.onPath ?? onPathDefault,
    exists: proc.exists ?? existsSync,
    readJson: proc.readJson ?? ((p: string) => JSON.parse(readFileSync(p, "utf8"))),
  };
}

// Absolute JS entry for an adapter installed under `prefixDir` (an npm --prefix root:
// package lives at prefixDir/node_modules/<pkg>). Reads the package's bin mapping.
export function adapterEntry(
  prefixDir: string, pkg: string, binName: string,
  readJson: (p: string) => unknown, exists: (p: string) => boolean,
): string | null {
  const pkgDir = join(prefixDir, "node_modules", pkg);
  const manifest = join(pkgDir, "package.json");
  let rel: string | undefined;
  try {
    const bin = (readJson(manifest) as { bin?: unknown }).bin;
    if (typeof bin === "string") rel = bin;
    else if (bin && typeof bin === "object") rel = (bin as Record<string, string>)[binName];
  } catch { return null; }
  if (!rel) return null;
  const entry = join(pkgDir, rel);
  return exists(entry) ? entry : null;
}

export function resolveAdapterSource(descriptor: AgentDescriptor, ctx: AdapterCtx): ResolvedSource {
  const bin = descriptor.command[0];
  const exists = ctx.exists ?? existsSync;
  const readJson = ctx.readJson ?? ((p: string) => JSON.parse(readFileSync(p, "utf8")));
  const onPath = ctx.onPath ?? onPathDefault;
  const pkg = descriptor.package;

  if (onPath(bin)) return { source: "path", binOnPath: bin };

  if (pkg) {
    const managed = adapterEntry(managedAdapterDir(ctx.home, descriptor.id), pkg, bin, readJson, exists);
    if (managed) return { source: "managed", entry: managed };
    if (ctx.runtime === "desktop" && ctx.resourcesPath) {
      const bundled = adapterEntry(bundledAdapterDir(ctx.resourcesPath, descriptor.id), pkg, bin, readJson, exists);
      if (bundled) return { source: "bundled", entry: bundled };
    }
  }
  return { source: "missing" };
}

// Build an absolute, spawnable descriptor from the resolved source, or null if missing.
//  • path    → keep the bare command (already resolvable on PATH), no env overlay.
//  • managed/bundled → [ctx.execPath, entry, ...extraArgs]; on desktop overlay
//    ELECTRON_RUN_AS_NODE=1 so Electron's own binary runs the Node adapter.
export function resolveLaunch(descriptor: AgentDescriptor, ctx: AdapterCtx): AgentDescriptor | null {
  const r = resolveAdapterSource(descriptor, ctx);
  if (r.source === "missing") return null;
  if (r.source === "path") {
    return { ...descriptor, command: [r.binOnPath ?? descriptor.command[0], ...descriptor.command.slice(1)] };
  }
  const command = [ctx.execPath, r.entry!, ...descriptor.command.slice(1)];
  // Merge (not replace) onto the descriptor's own overlay — e.g. a per-task
  // ANTHROPIC_MODEL from agentTasks must survive the desktop launch rewrite.
  const env = ctx.runtime === "desktop" ? { ...descriptor.env, ELECTRON_RUN_AS_NODE: "1" } : descriptor.env;
  return env ? { ...descriptor, command, env } : { ...descriptor, command };
}

export class AdapterConsentError extends Error {
  code = "consent_required" as const;
  constructor(msg = "install requires consent") { super(msg); this.name = "AdapterConsentError"; }
}

export type NpmSpawn = (cmd: string, args: string[]) => Promise<{ code: number; stderr: string }>;

const defaultNpmSpawn: NpmSpawn = (cmd, args) => new Promise((resolve) => {
  const child = spawnChild(cmd, args, { stdio: ["ignore", "ignore", "pipe"], shell: process.platform === "win32" });
  let stderr = "";
  child.stderr?.on("data", (d) => { stderr += String(d); });
  child.once("error", (e) => resolve({ code: 1, stderr: e.message }));
  child.once("close", (code) => resolve({ code: code ?? 1, stderr }));
});

// Production AdapterInstaller: `npm install <pkg>@<version> --prefix <destPrefix>`.
// Only exercised by the opt-in smoke script; CI always injects a fake installer.
export function npmAdapterInstaller(spawnFn: NpmSpawn = defaultNpmSpawn): AdapterInstaller {
  return async (pkg, version, destPrefix) => {
    const { code, stderr } = await spawnFn("npm", [
      "install", `${pkg}@${version}`, "--prefix", destPrefix, "--no-audit", "--no-fund", "--loglevel=error",
    ]);
    if (code !== 0) throw new Error(`npm install ${pkg}@${version} failed: ${stderr.trim().slice(-500) || `exit ${code}`}`);
  };
}

export type AdapterInstaller = (pkg: string, version: string, destPrefix: string) => Promise<void>;
export interface EnsureResult { available: boolean; source: AdapterSource }
export interface EnsureOpts {
  consent: boolean;
  install: AdapterInstaller;
  fs?: { rm(p: string): void; rename(a: string, b: string): void; mkdirp(p: string): void };
}

// One in-flight install per adapter id, so a second caller awaits the first.
const installLocks = new Map<string, Promise<EnsureResult>>();

export async function ensureAdapter(descriptor: AgentDescriptor, ctx: AdapterCtx, opts: EnsureOpts): Promise<EnsureResult> {
  const existing = resolveAdapterSource(descriptor, ctx);
  if (existing.source !== "missing") return { available: true, source: existing.source };

  if (!descriptor.package || !descriptor.version) throw new Error(`no install source for ${descriptor.id}`);
  if (ctx.runtime === "desktop") throw new Error(`${descriptor.name} adapter is missing from the app — reinstall the app`);
  if (!opts.consent) throw new AdapterConsentError();

  const inflight = installLocks.get(descriptor.id);
  if (inflight) return inflight;

  const run = (async (): Promise<EnsureResult> => {
    const fs = opts.fs ?? {
      rm: (p: string) => rmSync(p, { recursive: true, force: true }),
      rename: (a: string, b: string) => renameSync(a, b),
      mkdirp: (p: string) => mkdirSync(p, { recursive: true }),
    };
    const finalDir = managedAdapterDir(ctx.home, descriptor.id);
    const tmpDir = `${finalDir}.installing`;
    fs.rm(tmpDir);
    fs.mkdirp(tmpDir);
    await opts.install(descriptor.package!, descriptor.version!, tmpDir);
    fs.rm(finalDir);
    fs.rename(tmpDir, finalDir);
    const after = resolveAdapterSource(descriptor, ctx);
    if (after.source === "missing") throw new Error(`install of ${descriptor.name} did not produce a runnable adapter`);
    return { available: true, source: after.source };
  })();

  installLocks.set(descriptor.id, run);
  try { return await run; }
  finally { installLocks.delete(descriptor.id); }
}
