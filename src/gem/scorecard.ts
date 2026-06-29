// src/gem/scorecard.ts
//
// Deterministic "goldmine scorecard": rolls the existing analyze pipeline's
// per-project candidates up into asset-framed counts. Pure — no fs, no LLM.
// breadth = distinct reusable workflows; battleTested = mature (priorConfidence
// "high"); portable = mature AND general enough to travel beyond its origin repo.
import { basename } from "node:path";
import type { WorkflowSignal } from "./workflowScan.js";
import type { ProcedureCandidate, Reflection } from "./distillTypes.js";

// A workflow "travels" when it leans on portable capability (a Skill or an MCP
// tool) rather than only repo-local edits (Bash/Edit/Write). This is the
// implementable form of the spec's `ArtifactUsage.root === null` portability
// proxy, computed from the candidate's own tool list.
const PORTABLE_TOOL_RE = /^(Skill|mcp__)/;
const MAX_GAPS = 5;
const TOP_CANDIDATES = 5;

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
  topCandidates: { name: string; confidence: "high" | "medium" | "low" }[];
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
  return c.priorConfidence === "high" && c.skeleton.tools.some((t) => PORTABLE_TOOL_RE.test(t));
}

export function scoreProject(load: ProjectLoad): ProjectGoldmine {
  const cs = load.candidates;
  return {
    root: load.root,
    label: load.label || basename(load.root),
    breadth: new Set(cs.map((c) => c.key)).size,
    battleTested: cs.filter((c) => c.priorConfidence === "high").length,
    portable: cs.filter(isPortable).length,
    topCandidates: cs.slice(0, TOP_CANDIDATES).map((c) => ({ name: c.skeleton.name, confidence: c.priorConfidence })),
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
