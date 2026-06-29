// src/gem/scorecard.ts
//
// Deterministic "goldmine scorecard": rolls the existing analyze pipeline's
// per-project candidates up into asset-framed counts. The aggregate/score
// functions (isPortable/scoreProject/aggregateScorecard) are pure — no fs, no
// LLM; `defaultScorecardDeps` runs the real pipeline (fs, still no LLM).
// breadth = distinct reusable workflows; battleTested = mature (priorConfidence
// "high"); portable = mature AND general enough to travel beyond its origin repo.
import { basename } from "node:path";
import { discoverProjects } from "./testbedFlavors.js";
import { resolveDirs, resolveProject } from "../resolveDir.js";
import { introspectProject, introspectConfig } from "./introspect.js";
import { claudeTranscriptsForCwd, scanWorkflow } from "./workflowScan.js";
import { extractCandidates } from "./extract.js";
import type { WorkflowSignal } from "./workflowScan.js";
import type { ProcedureCandidate, Reflection } from "./distillTypes.js";

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

export type WorkflowItem = { key: string; name: string; confidence: "high" | "medium" | "low"; portable: boolean };

export type ProjectLoad = {
  root: string;
  label: string;
  signal: WorkflowSignal;
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
  loadProject(root: string, dir?: string): { signal: WorkflowSignal; candidates: ProcedureCandidate[]; reflections: Reflection[] } | null;
}

// Default deps run the real, shipped analyze pipeline — the same wiring as
// src/workflowStream.ts, minus the LLM (deterministic only).
export const defaultScorecardDeps: ScorecardDeps = {
  discover: (dir) => discoverProjects(resolveDirs(dir)).map((p) => ({ path: p.path, lastUsed: p.lastUsed })),
  loadProject: (root, dir) => {
    try {
      const dirs = resolveDirs(dir);
      const project = introspectProject(resolveProject(root));
      const globalInv = introspectConfig(dirs);
      const scanInv = { project, global: { skills: globalInv.skills, mcpServers: globalInv.mcpServers, hooks: globalInv.hooks } };
      const paths = claudeTranscriptsForCwd(dirs.claudeDir, root);
      const signal = scanWorkflow(paths, scanInv, { retainSequences: true });
      const { candidates, reflections } = extractCandidates(signal, scanInv);
      return { signal, candidates, reflections };
    } catch {
      return null;
    }
  },
};

export function collectScorecard(
  dir: string | undefined,
  projects: string[] | undefined,
  nowMs: number,
  deps: ScorecardDeps = defaultScorecardDeps,
): Scorecard {
  let roots: string[];
  if (projects?.length) {
    roots = projects;
  } else {
    const discovered = [...deps.discover(dir)].sort((a, b) => (b.lastUsed ?? "").localeCompare(a.lastUsed ?? ""));
    if (discovered.length > MAX_PROJECTS) {
      console.warn(`[scorecard] ${discovered.length} projects discovered; scanning the ${MAX_PROJECTS} most recent (perf bound).`);
    }
    roots = discovered.slice(0, MAX_PROJECTS).map((p) => p.path);
  }
  const loads: ProjectLoad[] = [];
  let degraded = false;
  for (const root of roots) {
    const loaded = deps.loadProject(root, dir);
    if (!loaded) { degraded = true; continue; }
    loads.push({ root, label: basename(root), ...loaded });
  }
  return aggregateScorecard(loads, nowMs, degraded);
}
