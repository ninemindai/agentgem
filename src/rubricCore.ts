// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/rubricCore.ts
//
// Headless, cache-aware core for evaluating one rubric at a given scope. Selects
// transcripts by scope (session / project / all), scans them, runs the rubric's
// cheap factors (evaluateRubric), and caches on the shared computeCached skeleton.
//
// Cache key is a CONTENT hash of the rubric (not its id): editing a rubric's
// factors/weights in place must invalidate its cached report (eng-review A1/E2).
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { introspectConfig, introspectProject } from "@agentgem/capture";
import { resolveDirs, resolveProject } from "@agentgem/model";
import {
  claudeTranscriptsForCwd, allClaudeTranscripts, scanWorkflow,
  transcriptToken, readAnalysisCacheEntry, writeAnalysisCache,
  computeCached, type CacheHit,
  builtinRubrics, loadRubrics, evaluateRubric,
  DETECTORS, loadRuleDetectors,
  type Rubric, type RubricScope, type RubricReport, type WorkflowSignal,
} from "@agentgem/insight";

// Cache namespace for rubric reports (distinct from per-project analysis caches).
const RUBRIC_CACHE_ROOT = "__rubric__";

function scopeKey(scope: RubricScope): string {
  if (scope.kind === "session") return `session:${scope.root}:${scope.sessionId}`;
  if (scope.kind === "project") return `project:${scope.root}`;
  return "all";
}

/** Content-hash cache key: scope + the scanned transcripts + the rubric's canonical JSON. */
export function rubricToken(scope: RubricScope, paths: string[], rubric: Rubric): string {
  const rubricHash = createHash("sha1").update(JSON.stringify(rubric)).digest("hex").slice(0, 12);
  return `${scopeKey(scope)}|${transcriptToken(paths)}|${rubricHash}`;
}

/** The factor pool: built-in detectors + user declarative rules. */
export function rubricRegistry() {
  return [...DETECTORS, ...loadRuleDetectors()];
}

/** Resolve a rubric id against built-ins + ~/.agentgem/rubrics (built-ins win). */
export function resolveRubric(id: string, dir?: string): Rubric | null {
  const builtins = builtinRubrics();
  const found = builtins.find((r) => r.id === id);
  if (found) return found;
  const reserved = new Set(rubricRegistry().map((s) => s.id));
  return loadRubrics(dir, reserved).find((r) => r.id === id) ?? null;
}

/** All available rubrics (built-ins first, then user rubrics), for the picker. */
export function listRubrics(dir?: string): Rubric[] {
  const reserved = new Set(rubricRegistry().map((s) => s.id));
  return [...builtinRubrics(), ...loadRubrics(dir, reserved)];
}

function selectPaths(scope: RubricScope, claudeDir: string): string[] {
  if (scope.kind === "all") return allClaudeTranscripts(claudeDir);
  const all = claudeTranscriptsForCwd(claudeDir, scope.root);
  if (scope.kind === "session") {
    // Fast path: the transcript basename is the session id. Fall back to scanning
    // the whole project and filtering the signal (below) when it doesn't match.
    const one = all.find((p) => basename(p).replace(/\.jsonl$/, "") === scope.sessionId);
    return one ? [one] : all;
  }
  return all;
}

function scanInventory(scope: RubricScope, dir?: string) {
  const dirs = resolveDirs(dir);
  if (scope.kind === "all") {
    return { project: { root: "*", name: "All projects", skills: [], mcpServers: [], hooks: [], instructions: [] } };
  }
  const project = introspectProject(resolveProject(scope.root));
  const globalInv = introspectConfig(dirs);
  return { project, global: { skills: globalInv.skills, mcpServers: globalInv.mcpServers, hooks: globalInv.hooks } };
}

export interface RubricResult { payload: RubricReport; cached: boolean; updatedAt: number | null }

export async function computeRubric(
  rubric: Rubric,
  scope: RubricScope,
  opts: { dir?: string; force?: boolean; now?: () => number; registry?: ReturnType<typeof rubricRegistry> } = {},
): Promise<RubricResult> {
  const now = opts.now ?? Date.now;
  const dirs = resolveDirs(opts.dir);
  const paths = selectPaths(scope, dirs.claudeDir);
  const token = rubricToken(scope, paths, rubric);

  return computeCached<RubricReport>({
    token, force: opts.force, now,
    read: (t) => readAnalysisCacheEntry(RUBRIC_CACHE_ROOT, t) as CacheHit<RubricReport> | null,
    write: (t, payload, ts) => writeAnalysisCache(RUBRIC_CACHE_ROOT, t, payload, ts),
    degraded: (p) => p.degraded,
    compute: async () => {
      const scanInv = scanInventory(scope, opts.dir);
      let signal = scanWorkflow(paths, scanInv, { retainSequences: true });
      // Session scope: keep only the requested session (handles the fallback where
      // selectPaths scanned the whole project because the basename didn't match).
      if (scope.kind === "session") {
        const sessions = (signal.sequences?.sessions ?? []).filter((s) => s.sessionId === scope.sessionId);
        signal = {
          ...signal,
          sequences: signal.sequences ? { ...signal.sequences, sessions } : signal.sequences,
          sessions: { ...signal.sessions, scanned: sessions.length },
        } as WorkflowSignal;
      }
      return evaluateRubric(signal, rubric, { scope, registry: opts.registry ?? rubricRegistry() });
    },
  });
}
