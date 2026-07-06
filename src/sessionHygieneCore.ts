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
  HYGIENE_FACTOR_IDS, summariesForSpecs, resolveClaudeSession,
  type WorkflowSignal, type TurnUsage, type DetectorSummary, type HygieneVerdict,
} from "@agentgem/insight";
import { introspectConfig, introspectProject } from "@agentgem/capture";
import { resolveDirs, resolveProject, type ConfigInventory, type ProjectInventory } from "@agentgem/model";

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
  factors: DetectorSummary[];
  hygiene: HygieneVerdict;
}

export function buildHygieneReport(signal: WorkflowSignal): HygieneReport {
  const session = signal.sequences?.sessions?.[0];
  const model = session?.model ?? null;
  const specs = DETECTORS.filter((d) => HYGIENE_FACTOR_IDS.has(d.id));
  const factors = summariesForSpecs(specs, runDetectors(signal));
  return {
    meta: {
      sessionId: session?.sessionId ?? "",
      transcript: session?.transcript ?? "",
      model,
      cap: contextCap(model ?? undefined),
    },
    curve: session?.contextSeries ?? [],
    factors,
    hygiene: hygieneScore(factors),
  };
}

export async function sessionHygiene(id: string, agent: string): Promise<HygieneReport> {
  if (agent !== "claude") throw new Error("Context hygiene is available for Claude sessions only.");
  const found = await resolveClaudeSession(id);
  if (!found || !found.cwd) throw new Error(`No Claude session '${id}' found (or it has no recorded project).`);
  const inventory = introspectAll(undefined, [found.cwd]);
  const project = (inventory.projects ?? []).find((p: ProjectInventory) => p.root === resolveProject(found.cwd!));
  if (!project) throw new Error(`Project for session '${id}' not found in inventory.`);
  const scanInv = { project, global: { skills: inventory.skills, mcpServers: inventory.mcpServers, hooks: inventory.hooks } };
  const signal = scanWorkflow([found.path], scanInv, { retainSequences: true });
  return buildHygieneReport(signal);
}
