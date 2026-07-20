// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/sessionHygieneCore.ts
//
// Per-session context-hygiene report: run the five hygiene detectors + score
// over one scanned transcript and shape the result for Inspect → Session. The
// scan/resolve setup mirrors inspectDistill; all detector logic and thresholds
// come from @agentgem/insight (no re-implementation here).
import {
  scanWorkflow, runDetectors, DETECTORS, hygieneScore, contextCap,
  HYGIENE_FACTOR_IDS, summariesForSpecs, resolveClaudeSession, boundarySegments,
  type WorkflowSignal, type TurnUsage, type DetectorSummary, type HygieneVerdict, type ScanInventory, type SessionBoundary,
  type SkillAgentEvent,
} from "@agentgem/insight";
import { introspectConfig, introspectProject } from "@agentgem/capture";
import { resolveDirs, resolveProject, type ConfigInventory, type ProjectInventory } from "@agentgem/model";

// Tags the user-facing guard failures so the controller can map exactly these
// to a 400 (InvalidInputError) and let unexpected internal faults become 500s
// instead of echoing a raw error message (which could contain a path).
export class HygieneInputError extends Error {}

// Same composition as the private introspectAll() in gem.controller.ts (not itself
// exported from @agentgem/capture) — scoped here to the single project root a
// resolved session carries.
function introspectAll(dir: string | undefined, projects: string[] | undefined): ConfigInventory {
  const inventory = introspectConfig(resolveDirs(dir));
  const roots = (projects ?? []).map(resolveProject).filter((r, i, a) => r.length > 0 && a.indexOf(r) === i);
  if (roots.length) inventory.projects = roots.map(introspectProject);
  return inventory;
}

export interface HygieneReport {
  meta: { sessionId: string; transcript: string; model: string | null; cap: number };
  curve: TurnUsage[];
  events: SkillAgentEvent[];
  factors: DetectorSummary[];
  hygiene: HygieneVerdict;
  boundary?: SessionBoundary;
}

export function buildHygieneReport(signal: WorkflowSignal): HygieneReport {
  const session = signal.sequences?.sessions?.[0];
  const model = session?.model ?? null;
  const specs = DETECTORS.filter((d) => HYGIENE_FACTOR_IDS.has(d.id));
  const factors = summariesForSpecs(specs, runDetectors(signal));
  const boundary = session ? boundarySegments(session) : undefined;
  return {
    meta: {
      sessionId: session?.sessionId ?? "",
      transcript: session?.transcript ?? "",
      model,
      cap: contextCap(model ?? undefined),
    },
    curve: session?.contextSeries ?? [],
    events: session?.eventSeries ?? [],
    factors,
    hygiene: hygieneScore(factors),
    ...(boundary && boundary.segments.length >= 2 ? { boundary } : {}),
  };
}

// A watched live transcript is a bare file path, not a resolvable session id, and
// the hygiene detectors need only contextSeries + the scrubbed step spine — never
// resolved artifacts. So scan the one file with an empty inventory (the shape the
// unit tests use) and reuse buildHygieneReport. Sibling of sessionHygiene, without
// the resolveClaudeSession / project-inventory step.
const MINIMAL_INV = {
  project: { root: "", skills: [], mcpServers: [], hooks: [], instructions: [] },
  global: { skills: [], mcpServers: [], hooks: [] },
} as unknown as ScanInventory;

export function hygieneReportForFile(path: string): HygieneReport {
  return buildHygieneReport(scanWorkflow([path], MINIMAL_INV, { retainSequences: true }));
}

export async function sessionHygiene(id: string, agent: string): Promise<HygieneReport> {
  if (agent !== "claude") throw new HygieneInputError("Context hygiene is available for Claude sessions only.");
  const found = await resolveClaudeSession(id);
  if (!found || !found.cwd) throw new HygieneInputError(`No Claude session '${id}' found (or it has no recorded project).`);
  const inventory = introspectAll(undefined, [found.cwd]);
  const project = (inventory.projects ?? []).find((p: ProjectInventory) => p.root === resolveProject(found.cwd!));
  if (!project) throw new HygieneInputError(`Project for session '${id}' not found in inventory.`);
  const scanInv = { project, global: { skills: inventory.skills, mcpServers: inventory.mcpServers, hooks: inventory.hooks } };
  const signal = scanWorkflow([found.path], scanInv, { retainSequences: true });
  return buildHygieneReport(signal);
}
