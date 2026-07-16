// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/scorecard.ts
//
// Deterministic "goldmine scorecard": rolls the existing analyze pipeline's
// per-project candidates up into asset-framed counts. The aggregate/score
// functions (isPortable/scoreProject/aggregateScorecard) are pure — no fs, no
// LLM; `defaultScorecardDeps` runs the real pipeline (fs, still no LLM).
// breadth = distinct reusable workflows; battleTested = mature (priorConfidence
// "high"); portable = mature AND general enough to travel beyond its origin repo.
import { basename } from "node:path";
import { discoverProjects } from "@agentgem/testbed";
import { normalizeProjectRoot, resolveDirs, resolveProject } from "@agentgem/model";
import { introspectProject, introspectConfig } from "@agentgem/capture";
import { claudeTranscriptsForCwd, scanWorkflow, bucketTranscriptsByCwd } from "@agentgem/insight";
import { extractCandidates, transcriptToken, readAnalysisCache, writeAnalysisCache } from "@agentgem/insight";
import type { WorkflowSignal } from "@agentgem/insight";
import type { ProcedureCandidate, Reflection } from "@agentgem/insight";
import { createLogger } from "@agentgem/base";

const log = createLogger("scorecard");

// A workflow "travels" when it does more than hand-edit one repo — i.e. it uses
// at least one tool beyond the repo-local edit set. (Skill/MCP usage is NOT
// recorded in a candidate's step tools, so an earlier Skill|mcp regex collapsed
// to 0 on real data; non-local tools — web, sub-agents, orchestration — are the
// reliable portability signal that's actually present.)
const LOCAL_TOOLS = new Set(["Read", "Edit", "Write", "Bash", "Grep", "Glob", "LS"]);
const MAX_GAPS = 5;
const WORKFLOWS_PER_PROJECT = 12;
// Perf bound: scanning a project re-reads the whole transcript store, so the
// default (discover-all) path is capped to the most-recently-used projects.
// Explicit `projects` queries bypass the cap.
const MAX_PROJECTS = 12;

export type ScorecardProgress = { done: number; total: number; label: string; partial: { breadth: number; battleTested: number; portable: number } };

export type WorkflowItem = { key: string; name: string; confidence: "high" | "medium" | "low"; portable: boolean };

export type ProjectLoad = {
  root: string;
  label: string;
  // The raw signal is only produced, never consumed by scoreProject/aggregateScorecard,
  // so a cache hit (which doesn't store the heavy signal) can legitimately omit it.
  signal?: WorkflowSignal;
  candidates: ProcedureCandidate[];
  reflections: Reflection[];
};

export type ProjectGoldmine = {
  root: string;
  label: string;
  breadth: number;
  battleTested: number;
  portable: number;
  workflows: WorkflowItem[];
};

export type Scorecard = {
  breadth: number;
  battleTested: number;
  portable: number;
  gaps: string[];
  projects: ProjectGoldmine[];
  generatedAtMs: number;
  degraded: boolean;
};

export function isPortable(c: ProcedureCandidate): boolean {
  return c.priorConfidence === "high" && c.skeleton.tools.some((t) => !LOCAL_TOOLS.has(t));
}

export function scoreProject(load: ProjectLoad): ProjectGoldmine {
  const cs = load.candidates;
  const rank = { high: 0, medium: 1, low: 2 } as const;
  const workflows: WorkflowItem[] = [...cs]
    .sort((a, b) => rank[a.priorConfidence] - rank[b.priorConfidence] || b.sessions - a.sessions)
    .slice(0, WORKFLOWS_PER_PROJECT)
    .map((c) => ({ key: c.key, name: c.skeleton.name, confidence: c.priorConfidence, portable: isPortable(c) }));
  return {
    root: load.root,
    label: load.label || basename(load.root),
    breadth: new Set(cs.map((c) => c.key)).size,
    battleTested: cs.filter((c) => c.priorConfidence === "high").length,
    portable: cs.filter(isPortable).length,
    workflows,
  };
}

export function aggregateScorecard(loads: ProjectLoad[], nowMs: number, degraded: boolean): Scorecard {
  const projects = loads.map(scoreProject);
  const allKeys = new Set<string>();
  let battleTested = 0;
  let portable = 0;
  const gaps: string[] = [];
  for (const load of loads) {
    for (const c of load.candidates) {
      allKeys.add(c.key);
      if (c.priorConfidence === "high") battleTested++;
      if (isPortable(c)) portable++;
    }
    // Only high-importance reflections become headline gaps (medium ones are noise here).
    for (const r of load.reflections) if (r.importance === "high" && !gaps.includes(r.detail)) gaps.push(r.detail);
  }
  return {
    breadth: allKeys.size,
    battleTested,
    portable,
    gaps: gaps.slice(0, MAX_GAPS),
    projects,
    generatedAtMs: nowMs,
    degraded,
  };
}

export interface ScorecardDeps {
  discover(dir?: string): { path: string; lastUsed?: string | null }[];
  loadProject(root: string, dir?: string, paths?: string[]): { signal: WorkflowSignal; candidates: ProcedureCandidate[]; reflections: Reflection[] } | null;
  transcriptsFor(root: string, dir?: string): string[];
  bucketTranscripts(dir?: string): Map<string, string[]>;
  // Per-project analysis cache. Optional: when a deps object omits these (e.g. unit
  // tests), every project is re-scanned — the caching is opt-in via the default deps.
  readProjectCache?(key: string, token: string): unknown | null;
  writeProjectCache?(key: string, token: string, value: unknown, nowMs: number): void;
}

// Per-project cache namespace. Each project is keyed by ITS OWN transcript token, so
// adding a session to one project invalidates only that project — where the aggregate
// token (route/stream/warm layers) would force a re-scan of all ~12 on any change.
// Namespaced so it can't collide with the analyze pipeline, which caches a DIFFERENT
// (LLM-derived) payload under the bare <root> key.
export const SCORECARD_PROJECT_PREFIX = "scorecard:";
// Cache key for the aggregate scorecard (distinct from per-project keys). Shared by
// the SSE route (scorecard.stream.controller.ts) and the warm worker.
export const SCORECARD_CACHE_ROOT = "__scorecard__";
type CachedProjectLoad = { label: string; candidates: ProcedureCandidate[]; reflections: Reflection[] };

/** Load one project's deterministic candidates, cache-first when deps expose a cache.
 *  The heavy `signal` is deliberately not cached (unused downstream) to keep entries small. */
export function loadProjectCached(deps: ScorecardDeps, root: string, dir: string | undefined, paths: string[], nowMs: number): ProjectLoad | null {
  const label = basename(root);
  if (deps.readProjectCache && deps.writeProjectCache) {
    const key = SCORECARD_PROJECT_PREFIX + root;
    const token = transcriptToken(paths);
    const hit = deps.readProjectCache(key, token) as CachedProjectLoad | null;
    if (hit) return { root, label: hit.label, candidates: hit.candidates, reflections: hit.reflections };
    const loaded = deps.loadProject(root, dir, paths);
    if (!loaded) return null;
    const entry: CachedProjectLoad = { label, candidates: loaded.candidates, reflections: loaded.reflections };
    deps.writeProjectCache(key, token, entry, nowMs);
    return { root, ...entry, signal: loaded.signal };
  }
  const loaded = deps.loadProject(root, dir, paths);
  return loaded ? { root, label, ...loaded } : null;
}

// Default deps run the real, shipped analyze pipeline — the same wiring as
// src/workflowStream.ts, minus the LLM (deterministic only).
export const defaultScorecardDeps: ScorecardDeps = {
  discover: (dir) => discoverProjects(resolveDirs(dir)).map((p) => ({ path: p.path, lastUsed: p.lastUsed })),
  loadProject: (root, dir, paths) => {
    try {
      const dirs = resolveDirs(dir);
      const project = introspectProject(resolveProject(root));
      const globalInv = introspectConfig(dirs);
      const scanInv = { project, global: { skills: globalInv.skills, mcpServers: globalInv.mcpServers, hooks: globalInv.hooks } };
      const transcripts = paths ?? claudeTranscriptsForCwd(dirs.claudeDir, root);
      const signal = scanWorkflow(transcripts, scanInv, { retainSequences: true });
      const { candidates, reflections } = extractCandidates(signal, scanInv);
      return { signal, candidates, reflections };
    } catch {
      return null;
    }
  },
  transcriptsFor: (root, dir) => claudeTranscriptsForCwd(resolveDirs(dir).claudeDir, root),
  bucketTranscripts: (dir) => bucketTranscriptsByCwd(resolveDirs(dir).claudeDir),
  readProjectCache: (key, token) => readAnalysisCache(key, token),
  writeProjectCache: (key, token, value, nowMs) => writeAnalysisCache(key, token, value, nowMs),
};

export function selectScorecardRoots(dir: string | undefined, projects: string[] | undefined, deps: ScorecardDeps = defaultScorecardDeps): string[] {
  // Explicit roots may be worktree/subdir paths (e.g. from recents); fold each to
  // its git checkout so they match the normalized transcript buckets, and dedup.
  if (projects?.length) return [...new Set(projects.map(normalizeProjectRoot))];
  const discovered = [...deps.discover(dir)].sort((a, b) => (b.lastUsed ?? "").localeCompare(a.lastUsed ?? ""));
  if (discovered.length > MAX_PROJECTS) {
    log.warn("[scorecard] %d projects discovered; scanning the %d most recent (perf bound).", discovered.length, MAX_PROJECTS);
  }
  return discovered.slice(0, MAX_PROJECTS).map((p) => p.path);
}

export function scorecardTranscriptPaths(roots: string[], bucket: Map<string, string[]>): string[] {
  return roots.flatMap((r) => bucket.get(r) ?? []);
}

export function collectScorecard(
  dir: string | undefined,
  projects: string[] | undefined,
  nowMs: number,
  opts: { deps?: ScorecardDeps; onProgress?: (p: ScorecardProgress) => void; bucket?: Map<string, string[]> } = {},
): Scorecard {
  const deps = opts.deps ?? defaultScorecardDeps;
  const roots = selectScorecardRoots(dir, projects, deps);
  const bucket = opts.bucket ?? deps.bucketTranscripts(dir);
  const loads: ProjectLoad[] = [];
  let degraded = false;
  for (let i = 0; i < roots.length; i++) {
    const root = roots[i];
    const load = loadProjectCached(deps, root, dir, bucket.get(root) ?? [], nowMs);
    if (!load) { degraded = true; }
    else loads.push(load);
    if (opts.onProgress) {
      const partial = aggregateScorecard(loads, nowMs, degraded);
      opts.onProgress({ done: i + 1, total: roots.length, label: basename(root), partial: { breadth: partial.breadth, battleTested: partial.battleTested, portable: partial.portable } });
    }
  }
  return aggregateScorecard(loads, nowMs, degraded);
}
