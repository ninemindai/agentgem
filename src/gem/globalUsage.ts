// src/gem/globalUsage.ts
//
// Pure global-usage scan: count which GLOBAL artifacts fired across the given
// transcripts. An empty project inventory means every resolved call attributes
// to a global (no project shadowing).
import { introspectConfig } from "./introspect.js";
import { scanWorkflow } from "./workflowScan.js";
import type { resolveDirs } from "../resolveDir.js";

export interface GlobalUsageResult {
  artifacts: { type: string; name: string; root: null; invocations: number; sessionsUsedIn: number; lastUsedMs: number | null }[];
}

export function computeGlobalUsage(dirs: ReturnType<typeof resolveDirs>, paths: string[]): GlobalUsageResult {
  const globalInv = introspectConfig(dirs);
  const emptyProject = { root: "", name: "", skills: [], mcpServers: [], instructions: [], hooks: [] };
  const scanInv = { project: emptyProject, global: { skills: globalInv.skills, mcpServers: globalInv.mcpServers, hooks: globalInv.hooks } };
  const signal = scanWorkflow(paths, scanInv);
  return {
    artifacts: signal.artifacts
      .filter((a) => a.root === null)
      .map((a) => ({ type: a.type, name: a.name, root: a.root as null, invocations: a.invocations, sessionsUsedIn: a.sessionsUsedIn, lastUsedMs: a.lastUsedMs })),
  };
}
