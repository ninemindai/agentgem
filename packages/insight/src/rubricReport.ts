// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/rubricReport.ts
//
// evaluateRubric: run one rubric's selected factors over an already-scanned (and
// already scope-selected) WorkflowSignal and produce a RubricReport. Phase 1 runs
// CHEAP factors only (built-in detectors + declarative rules); inline LLM criteria
// are recorded as skipped (Phase 2 wires judgeCriteria). Pure — no fs, no LLM, no
// scan; the caller (rubricCore) selects transcripts by scope and scans.
import { createLogger } from "@agentgem/base";
import type { WorkflowSignal } from "./workflowScan.js";
import type { DetectorSpec, DetectorFinding, DetectorSummary } from "./detectors.js";
import { DETECTORS, summarizeFindings } from "./detectors.js";
import { loadRuleDetectors } from "./detectorRules.js";
import { type Rubric, type RubricScope, type RubricScopeKind, rubricGranularity, scopeAllowed } from "./rubrics.js";

const log = createLogger("insight");

export interface RubricReport {
  rubricId: string;
  target: string;
  scope: RubricScopeKind;
  // One row per RESOLVED cheap factor — count 0 when it did not fire, so the
  // clean/zero-findings success state can list the checks that passed.
  factors: DetectorSummary[];
  sessionsScanned: number;
  clean: boolean;                 // no findings across the whole run (the success state)
  degraded: boolean;              // Phase 1 cheap-only: always false (Phase 2 sets it for LLM fallback)
  skippedFactors: { factor: string; reason: "unknown" | "llm-phase2" }[];
  // Present at scope "session" or for session-granular rubrics (§Scope). Lists ONLY
  // sessions that tripped a factor — a row per clean session explodes the payload at
  // scope "all" (1900+ sessions); the aggregate `factors` already carries the clean
  // picture. Capped at PER_SESSION_CAP with `perSessionTruncated` when there are more.
  perSession?: { sessionId: string; transcript: string; factors: DetectorSummary[] }[];
  perSessionTruncated?: boolean;
}

// Max per-session rows returned; beyond this, perSessionTruncated is set (no silent cap).
export const PER_SESSION_CAP = 200;

export interface EvaluateOpts {
  scope: RubricScope;
  registry?: DetectorSpec[];      // cheap-factor pool to resolve refs against (default: built-ins + user rules)
}

function defaultRegistry(): DetectorSpec[] {
  return [...DETECTORS, ...loadRuleDetectors()];
}

// Run an explicit spec list over the signal's retained sessions. Never throws: a
// broken factor logs and contributes nothing (mirrors runDetectors, but for an
// explicit subset rather than the full built-in set).
function runSpecs(signal: WorkflowSignal, specs: DetectorSpec[]): DetectorFinding[] {
  const sessions = signal.sequences?.sessions ?? [];
  const out: DetectorFinding[] = [];
  for (const s of sessions) {
    for (const spec of specs) {
      try { out.push(...spec.detect(s, signal)); }
      catch (err) { log.warn("rubric factor %s failed: %s", spec.id, (err as Error)?.message ?? err); }
    }
  }
  return out;
}

// One summary row per resolved spec, count 0 when it did not fire.
function summariesForSpecs(specs: DetectorSpec[], findings: DetectorFinding[]): DetectorSummary[] {
  const fired = new Map(summarizeFindings(findings, specs).map((s) => [s.id, s]));
  return specs.map((spec) => fired.get(spec.id) ?? {
    id: spec.id, title: spec.title, advice: spec.advice, severity: spec.severity, count: 0, sessions: 0,
  });
}

/**
 * Evaluate a rubric over a scanned signal. Throws only on an invalid scope
 * combination (aggregate-only rubric at session scope) — the caller pre-checks
 * with scopeAllowed and turns that into a clean error response; the throw here is
 * the defensive guard.
 */
export function evaluateRubric(signal: WorkflowSignal, rubric: Rubric, opts: EvaluateOpts): RubricReport {
  const kind = opts.scope.kind;
  if (!scopeAllowed(rubric, kind)) {
    throw new Error(`rubric "${rubric.id}" is aggregate-only and cannot run at scope "session"`);
  }

  const byId = new Map((opts.registry ?? defaultRegistry()).map((s) => [s.id, s]));
  const inlineIds = new Set(rubric.criteria?.map((c) => c.id) ?? []);
  const resolved: DetectorSpec[] = [];
  const skippedFactors: RubricReport["skippedFactors"] = [];
  for (const ref of rubric.factors) {
    if (inlineIds.has(ref.factor)) { skippedFactors.push({ factor: ref.factor, reason: "llm-phase2" }); continue; }
    const spec = byId.get(ref.factor);
    if (!spec) {
      skippedFactors.push({ factor: ref.factor, reason: "unknown" });
      log.warn("rubric %s: unknown factor %s (skipped)", rubric.id, ref.factor);
      continue;
    }
    resolved.push(spec);
  }

  const findings = runSpecs(signal, resolved);
  const report: RubricReport = {
    rubricId: rubric.id,
    target: rubric.target,
    scope: kind,
    factors: summariesForSpecs(resolved, findings),
    sessionsScanned: signal.sessions?.scanned ?? (signal.sequences?.sessions?.length ?? 0),
    clean: findings.length === 0,
    degraded: false,
    skippedFactors,
  };

  if (kind === "session" || rubricGranularity(rubric) === "session") {
    const bySession = new Map<string, DetectorFinding[]>();
    for (const f of findings) {
      const arr = bySession.get(f.sessionId) ?? [];
      arr.push(f);
      bySession.set(f.sessionId, arr);
    }
    const withFindings = (signal.sequences?.sessions ?? []).filter((s) => bySession.has(s.sessionId));
    report.perSessionTruncated = withFindings.length > PER_SESSION_CAP;
    report.perSession = withFindings.slice(0, PER_SESSION_CAP).map((s) => ({
      sessionId: s.sessionId,
      transcript: s.transcript,
      factors: summariesForSpecs(resolved, bySession.get(s.sessionId)!),
    }));
  }

  return report;
}
