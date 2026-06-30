// src/gem/workspaces.ts
// A gem's persistent local home: the canonical archive at the workspace root (source of truth) plus
// .targets/<target>/ rendered harness layouts (derived). Orchestration over the pure archive/materialize
// core; this module owns all workspace filesystem I/O.
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync, readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import type { Gem } from "@agentgem/model";
import type { TargetId, SkippedArtifact, MaterializeOpts } from "@agentgem/model";
import { materialize, compatibility, TARGET_REGISTRY, safePathSegment } from "@agentgem/model";
import { writeGemArchive, readGemArchive } from "@agentgem/archive";
import { writeArchiveDir, readArchiveDir } from "@agentgem/archive";
import { InvalidInputError } from "@agentgem/model";

const TARGETS_DIR = ".targets";

export interface WorkspaceSummary {
  name: string;
  gemName: string;
  version: string;
  artifactCounts: { skill: number; mcp_server: number; instructions: number; hook: number };
  artifacts: { type: string; name: string }[];
  modifiedMs: number; // dir mtime — for recency ordering (most-recent first)
  checks: number;
  renderedTargets: TargetId[];
}
export interface WorkspaceDetail extends WorkspaceSummary {
  files: Record<string, string>;
  compatibility: Record<TargetId, { supported: number; skipped: number }>;
}
export interface RenderResult {
  target: TargetId;
  files: Record<string, string>;
  skipped: SkippedArtifact[];
  path: string;
}

export function workspacesRoot(): string {
  const home = process.env.AGENTGEM_HOME ?? join(homedir(), ".agentgem");
  return join(home, "workspaces");
}

// A workspace name must already be a safe single path segment — reject anything else (no separators,
// no `.`/`..`), so two distinct requests never collide to one directory and nothing escapes the root.
export function workspaceName(name: string): string {
  const seg = safePathSegment(name);
  if (seg !== name) throw new InvalidInputError(`invalid workspace name '${name}' — use only [A-Za-z0-9._-], no separators`);
  return seg;
}
export function workspaceDir(name: string): string {
  return join(workspacesRoot(), workspaceName(name));
}

function countArtifacts(entries: { type: string }[]): WorkspaceSummary["artifactCounts"] {
  const c = { skill: 0, mcp_server: 0, instructions: 0, hook: 0 };
  for (const e of entries) if (e.type in c) (c as Record<string, number>)[e.type]++;
  return c;
}

function renderedTargets(dir: string): TargetId[] {
  const t = join(dir, TARGETS_DIR);
  if (!existsSync(t)) return [];
  return readdirSync(t).filter((n) => statSync(join(t, n)).isDirectory() && n in TARGET_REGISTRY) as TargetId[];
}

function summary(name: string, manifestJson: string, dir: string): WorkspaceSummary {
  const m = JSON.parse(manifestJson) as { name: string; version: string; artifacts: { type: string; name: string }[]; checks: unknown[] };
  return {
    name,
    gemName: m.name,
    version: m.version,
    artifactCounts: countArtifacts(m.artifacts),
    // The artifact (type, name) list lets a consumer reconstruct the selection
    // that built this workspace (e.g. the console's "Open" → re-curate).
    artifacts: m.artifacts.map((a) => ({ type: a.type, name: a.name })),
    modifiedMs: statSync(dir).mtimeMs,
    checks: m.checks.length,
    renderedTargets: renderedTargets(dir),
  };
}

export function createWorkspace(name: string, gem: Gem, opts: { version?: string } = {}): WorkspaceSummary {
  const dir = workspaceDir(name);
  if (existsSync(dir)) throw new Error(`workspace '${name}' already exists`);
  const { files } = writeGemArchive(gem, { version: opts.version });
  mkdirSync(dir, { recursive: true });
  writeArchiveDir(dir, files);
  return summary(workspaceName(name), files["gem.json"], dir);
}

export function listWorkspaces(): WorkspaceSummary[] {
  const root = workspacesRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((n) => statSync(join(root, n)).isDirectory() && existsSync(join(root, n, "gem.json")))
    .map((n) => summary(n, readFileSync(join(root, n, "gem.json"), "utf8"), join(root, n)))
    .sort((a, b) => b.modifiedMs - a.modifiedMs); // most-recent first
}

export function readWorkspace(name: string): WorkspaceDetail {
  const dir = workspaceDir(name);
  if (!existsSync(join(dir, "gem.json"))) throw new Error(`no workspace '${name}'`);
  const files = readArchiveDir(dir);               // skips .targets/ (Task 2)
  const gem = readGemArchive(files);             // verifies the lock
  return { ...summary(workspaceName(name), files["gem.json"], dir), files, compatibility: compatibility(gem) };
}

export function renderTarget(name: string, target: TargetId, opts: MaterializeOpts = {}): RenderResult {
  const dir = workspaceDir(name);
  if (!existsSync(join(dir, "gem.json"))) throw new Error(`no workspace '${name}'`);
  const gem = readGemArchive(readArchiveDir(dir));
  const { files, skipped } = materialize(gem, target, opts);
  const out = join(dir, TARGETS_DIR, target);
  rmSync(out, { recursive: true, force: true });   // clear stale renders
  mkdirSync(out, { recursive: true });
  writeArchiveDir(out, files);
  return { target, files, skipped, path: out };
}

export function deleteWorkspace(name: string): void {
  const dir = workspaceDir(name);
  if (!existsSync(dir)) throw new Error(`no workspace '${name}'`);
  rmSync(dir, { recursive: true, force: true });
}
