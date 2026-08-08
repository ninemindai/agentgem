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
import { createLogger } from "@agentgem/base";
import { introspectConfig, introspectProject } from "@agentgem/capture";
import { resolveDirs, resolveProject, type Gem } from "@agentgem/model";
import {
  claudeTranscriptsForCwd, allClaudeTranscripts, scanWorkflow,
  transcriptToken, readAnalysisCacheEntry, writeAnalysisCache,
  computeCached, type CacheHit,
  builtinRubrics, loadRubrics, validateRubric, defaultRubricsDir, evaluateRubric,
  artifactToRubric, rubricGranularity,
  DETECTORS, loadRuleDetectors,
  openRubricVerdictStore, foldCalibration, verdictsBySession,
  type Rubric, type RubricScope, type RubricReport, type WorkflowSignal, type AcpConnectFn, type RubricGranularity,
  type RubricVerdict, type VerdictValue,
} from "@agentgem/insight";

const log = createLogger("rubricCore");

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Cache namespace for rubric reports (distinct from per-project analysis caches).
const RUBRIC_CACHE_ROOT = "__rubric__";

function scopeKey(scope: RubricScope): string {
  if (scope.kind === "session") return `session:${scope.root}:${scope.sessionId}`;
  if (scope.kind === "project") return `project:${scope.root}`;
  return "all";
}

// Bump whenever evaluateRubric's OUTPUT shape or the judge contract changes. The rest
// of the token hashes inputs, so without this a report cached before such a change is
// served forever as if it were current — the transcripts and rubric never changed.
const RUBRIC_EVALUATOR_VERSION = 2;   // 2: criterion applicability denominators

/** Content-hash cache key: evaluator version + scope + scanned transcripts + the
 *  rubric's canonical JSON. */
export function rubricToken(scope: RubricScope, paths: string[], rubric: Rubric): string {
  const rubricHash = createHash("sha1").update(JSON.stringify(rubric)).digest("hex").slice(0, 12);
  return `v${RUBRIC_EVALUATOR_VERSION}|${scopeKey(scope)}|${transcriptToken(paths)}|${rubricHash}`;
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

/** Catalog listing with a `builtin` flag so the UI can gate edit/delete to user
 *  rubrics, and `granularity` so the picker can offer session scope only for
 *  session-granular rubrics (mirrors the server-side scopeAllowed hard rule). */
export function listRubricsWithMeta(dir?: string): (Rubric & { builtin: boolean; granularity: RubricGranularity })[] {
  const builtinIds = new Set(builtinRubrics().map((r) => r.id));
  return listRubrics(dir).map((r) => ({ ...r, builtin: builtinIds.has(r.id), granularity: rubricGranularity(r) }));
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

/**
 * Install a gem's rubric artifacts into the rubric store (~/.agentgem/rubrics),
 * where loadRubrics already reads them. validateRubric is the authority (bad
 * rubrics are skipped); a built-in id is never overwritten. Returns the ids
 * written and the names skipped. Callers wire this into an install flow (Phase 2).
 */
export function installRubricGem(gem: Gem, dir = defaultRubricsDir()): { installed: string[]; skipped: string[] } {
  const builtinIds = new Set(builtinRubrics().map((r) => r.id));
  const reserved = new Set(rubricRegistry().map((s) => s.id));
  const installed: string[] = [];
  const skipped: string[] = [];
  for (const art of gem.artifacts) {
    if (art.type !== "rubric") continue;
    const rubric = validateRubric(artifactToRubric(art), reserved);
    if (!rubric || builtinIds.has(rubric.id)) { skipped.push(art.name); continue; }
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${rubric.id}.json`), JSON.stringify(rubric, null, 2));
    installed.push(rubric.id);
  }
  return { installed, skipped };
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

  const result = await computeCached<RubricReport>({
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
  // Decorate AFTER the cache: verdicts must never be cached (see withVerdicts).
  return { ...result, payload: withVerdicts(result.payload) };
}

/**
 * Decorate a report with human verdicts: all-time calibration per factor, and the
 * current verdict per factor on each per-session row.
 *
 * Called on the RESULT of computeCached, never inside its `compute` closure —
 * computeRubric writes its payload to the analysis cache, so decorating inside
 * would bake verdicts into a cached report and a new verdict would stay invisible
 * until the cache turned over. Out here, verdicts are always fresh and the cached
 * artifact stays a pure analysis result.
 *
 * A read failure degrades to NO calibration (never to zero) and never disturbs the
 * findings: "0 wrong of 0 reviewed" would read as a criterion nobody has disputed,
 * which is the opposite of "we could not check".
 */
export function withVerdicts(payload: RubricReport, dataDir?: string): RubricReport {
  let store: ReturnType<typeof openRubricVerdictStore> | null = null;
  try {
    store = openRubricVerdictStore(dataDir);
    const rubricId = payload.rubricId;
    const calibration = foldCalibration(store.verdictRowsForFactors(rubricId, payload.factors.map((f) => f.id)));
    const factors = payload.factors.map((f) => {
      const c = calibration.get(f.id);
      return c ? { ...f, calibration: c } : f;
    });

    let perSession = payload.perSession;
    if (perSession?.length) {
      const bySession = verdictsBySession(store.verdictRowsForSessions(rubricId, perSession.map((s) => s.sessionId)));
      perSession = perSession.map((s) => {
        const v = bySession.get(s.sessionId);
        return v ? { ...s, verdicts: v } : s;
      });
    }
    return { ...payload, factors, ...(perSession ? { perSession } : {}) };
  } catch (err) {
    // `unavailable`, not silence. Omitting the line alone would make a broken store
    // indistinguishable from a factor nobody has triaged yet — the same
    // unfalsifiable-silence failure the roster contract closes, one layer down.
    log.warn("rubric verdicts: calibration unavailable, report unaffected: %s", (err as Error)?.message ?? err);
    return { ...payload, calibrationUnavailable: true };
  } finally {
    try { store?.close(); } catch { /* ignore */ }
  }
}

/**
 * Append one verdict. Throws on failure so the route answers non-2xx: a verdict is
 * user input, and silently dropping it is the one unrecoverable bug here — the
 * person believes their call was recorded. This deliberately differs from
 * reflectionStore's best-effort write, which is right for a derived signal.
 *
 * `atMs` is assigned HERE, never taken from the client.
 */
export function recordRubricVerdict(
  input: { sessionId: string; factorId: string; rubricId: string; verdict: VerdictValue; note?: string },
  dataDir?: string,
  now: () => number = Date.now,
): { ok: true; atMs: number } {
  const atMs = now();
  const store = openRubricVerdictStore(dataDir);
  try {
    const v: RubricVerdict = { ...input, atMs };
    store.recordVerdict(v);
    return { ok: true, atMs };
  } finally {
    try { store.close(); } catch { /* ignore */ }
  }
}
