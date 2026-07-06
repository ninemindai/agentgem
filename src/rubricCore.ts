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
import { basename, join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { introspectConfig, introspectProject } from "@agentgem/capture";
import { resolveDirs, resolveProject } from "@agentgem/model";
import {
  claudeTranscriptsForCwd, allClaudeTranscripts, scanWorkflow,
  transcriptToken, readAnalysisCacheEntry, writeAnalysisCache,
  computeCached, type CacheHit,
  builtinRubrics, loadRubrics, validateRubric, defaultRubricsDir, evaluateRubric,
  DETECTORS, loadRuleDetectors,
  type Rubric, type RubricScope, type RubricReport, type WorkflowSignal, type AcpConnectFn,
} from "@agentgem/insight";

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

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

/** Catalog listing with a `builtin` flag so the UI can gate edit/delete to user rubrics. */
export function listRubricsWithMeta(dir?: string): (Rubric & { builtin: boolean })[] {
  const builtinIds = new Set(builtinRubrics().map((r) => r.id));
  return listRubrics(dir).map((r) => ({ ...r, builtin: builtinIds.has(r.id) }));
}

// ── Authoring: validate / save / delete user rubrics (JSON in ~/.agentgem/rubrics) ──

export type FactorKind = "detector" | "rule" | "criterion" | "unknown";

/** Classify each factor ref so the editor can preview which resolve and which don't. */
export function resolveFactorKinds(rubric: Rubric): { factor: string; kind: FactorKind }[] {
  const builtins = new Set(DETECTORS.map((d) => d.id));
  const rules = new Set(loadRuleDetectors().map((s) => s.id));
  const criteria = new Set(rubric.criteria?.map((c) => c.id) ?? []);
  return rubric.factors.map((f) => ({
    factor: f.factor,
    kind: criteria.has(f.factor) ? "criterion" : builtins.has(f.factor) ? "detector" : rules.has(f.factor) ? "rule" : "unknown",
  }));
}

export interface RubricValidation {
  valid: boolean;
  error?: string;
  rubric?: Rubric;
  factors?: { factor: string; kind: FactorKind }[];
  unknownFactors?: string[];   // resolve to nothing — a warning (skipped at run), not a hard error
  saved?: boolean;
}

/** Dry-run validation for the live editor preview (no write). */
export function validateRubricInput(raw: unknown): RubricValidation {
  const reserved = new Set(rubricRegistry().map((s) => s.id));
  const rubric = validateRubric(raw, reserved);
  if (!rubric) {
    return { valid: false, error: "Invalid rubric: check id (kebab-case), title, target, a non-empty factors array, and that any inline criterion id doesn't collide with a built-in or rule id." };
  }
  if (builtinRubrics().some((b) => b.id === rubric.id)) {
    return { valid: false, error: `"${rubric.id}" is a built-in rubric id — choose a different id.` };
  }
  const factors = resolveFactorKinds(rubric);
  return { valid: true, rubric, factors, unknownFactors: factors.filter((f) => f.kind === "unknown").map((f) => f.factor) };
}

/** Validate + write a user rubric to <dir>/<id>.json. Returns the validation + saved flag. */
export function saveRubric(raw: unknown, dir = defaultRubricsDir()): RubricValidation {
  const v = validateRubricInput(raw);
  if (!v.valid || !v.rubric) return { ...v, saved: false };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${v.rubric.id}.json`), JSON.stringify(v.rubric, null, 2));
  return { ...v, saved: true };
}

/** Delete a user rubric file. Built-ins can't be deleted. */
export function deleteRubric(id: string, dir = defaultRubricsDir()): { deleted: boolean; error?: string } {
  if (typeof id !== "string" || !ID_RE.test(id)) return { deleted: false, error: "Invalid rubric id." };
  if (builtinRubrics().some((b) => b.id === id)) return { deleted: false, error: "Cannot delete a built-in rubric." };
  try { rmSync(join(dir, `${id}.json`)); return { deleted: true }; }
  catch { return { deleted: false, error: "No such user rubric." }; }
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
    return { project: { root: "*", name: "All projects", skills: [], mcpServers: [], hooks: [], instructions: [], subagents: [] } };
  }
  const project = introspectProject(resolveProject(scope.root));
  const globalInv = introspectConfig(dirs);
  return { project, global: { skills: globalInv.skills, mcpServers: globalInv.mcpServers, hooks: globalInv.hooks } };
}

export interface RubricResult { payload: RubricReport; cached: boolean; updatedAt: number | null }

export async function computeRubric(
  rubric: Rubric,
  scope: RubricScope,
  opts: {
    dir?: string; force?: boolean; now?: () => number; registry?: ReturnType<typeof rubricRegistry>;
    // Forwarded to the LLM criterion path (Phase 2); ignored for cheap-only rubrics.
    connectFn?: AcpConnectFn; timeoutMs?: number; onDelta?: (chunk: string) => void;
  } = {},
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
      return evaluateRubric(signal, rubric, {
        scope, registry: opts.registry ?? rubricRegistry(),
        connectFn: opts.connectFn, timeoutMs: opts.timeoutMs, onDelta: opts.onDelta,
      });
    },
  });
}
