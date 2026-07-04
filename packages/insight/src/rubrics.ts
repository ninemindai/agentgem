// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/rubrics.ts
//
// A rubric is a named, target-bound selection of factors — built-in detectors,
// declarative rules, or (Phase 2) inline LLM criteria — applied to sessions to
// produce one report. Rubrics are DATA: JSON files in ~/.agentgem/rubrics/ each
// hold one rubric (or an array), with the same load/validate/degrade contract as
// detectorRules.ts — never throws; bad JSON, invalid rubrics, and id collisions
// all degrade to "skipped" (logged). No code execution — a rubric is declarative,
// so there is nothing to sandbox, and the same format is the future distributable
// unit for rubric-pack Gems.
//
// Scope is a RUN parameter, not a rubric field: the same rubric can be pointed at a
// session, a project, or everything. A rubric only declares the granularity its
// factors support (session-granular iff every factor is), plus a `naturalScope`
// hint used as the picker default. See docs/proposals/session-rubrics.md §Scope.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentgemHome } from "@agentgem/model";
import { createLogger } from "@agentgem/base";
import type { DetectorSeverity } from "./detectors.js";
import { DETECTORS } from "./detectors.js";

const log = createLogger("insight");

/** Where to point a rubric: a single session, one project, or everything. */
export type RubricScope =
  | { kind: "session"; sessionId: string; root: string }
  | { kind: "project"; root: string }
  | { kind: "all" };

export type RubricScopeKind = RubricScope["kind"];
export type RubricGranularity = "session" | "aggregate";

/**
 * An LLM factor: a natural-language criterion judged per session. Phase 2 executes
 * these (judgeCriteria); Phase 1 validates the shape and skips them at evaluation.
 */
export interface LlmCriterion {
  id: string;                     // kebab-case, unique across factors (same ID_RE as rules)
  title: string;
  question: string;               // the judged criterion, in plain language
  severity?: DetectorSeverity;    // default "info"
  advice: string;                 // the canonical suggestion when it fires (the "so what")
  granularity?: RubricGranularity; // default "session"
}

export interface RubricFactorRef {
  factor: string;   // a built-in DETECTORS id, a loaded rule id, or an inline criterion id
  weight?: number;  // default 1; used only by the rollup
}

export interface Rubric {
  id: string;                     // kebab-case, unique
  title: string;
  target: string;                 // open string, like a detector id
  naturalScope?: RubricScopeKind; // picker default + soft-warn basis (§Scope)
  factors: RubricFactorRef[];
  criteria?: LlmCriterion[];      // inline LLM factors referenced by id in `factors` (Phase 2)
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SCOPE_KINDS: readonly RubricScopeKind[] = ["session", "project", "all"];
const GRANULARITIES: readonly RubricGranularity[] = ["session", "aggregate"];

function validCriterion(raw: unknown, seen: Set<string>): LlmCriterion | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.id !== "string" || !ID_RE.test(c.id) || seen.has(c.id)) return null;
  if (typeof c.title !== "string" || !c.title.trim()) return null;
  if (typeof c.question !== "string" || !c.question.trim()) return null;
  if (typeof c.advice !== "string" || !c.advice.trim()) return null;
  if (c.severity !== undefined && c.severity !== "info" && c.severity !== "warn") return null;
  if (c.granularity !== undefined && !GRANULARITIES.includes(c.granularity as RubricGranularity)) return null;
  return {
    id: c.id, title: c.title.trim(), question: c.question.trim(), advice: c.advice.trim(),
    severity: c.severity as DetectorSeverity | undefined,
    granularity: c.granularity as RubricGranularity | undefined,
  };
}

/**
 * Validate one rubric. `reservedIds` are factor ids that already exist elsewhere
 * (built-in detectors + loaded rules); an inline criterion whose id collides with a
 * reserved id is rejected rather than allowed to silently shadow it (eng-review A2).
 * Returns null on any structural problem — the caller degrades to "skipped".
 */
export function validateRubric(raw: unknown, reservedIds: ReadonlySet<string> = new Set(DETECTORS.map((d) => d.id))): Rubric | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !ID_RE.test(r.id)) return null;
  if (typeof r.title !== "string" || !r.title.trim()) return null;
  if (typeof r.target !== "string" || !r.target.trim()) return null;
  if (r.naturalScope !== undefined && !SCOPE_KINDS.includes(r.naturalScope as RubricScopeKind)) return null;
  if (!Array.isArray(r.factors) || r.factors.length === 0) return null;

  const factors: RubricFactorRef[] = [];
  for (const f of r.factors) {
    if (!f || typeof f !== "object") return null;
    const ref = f as Record<string, unknown>;
    if (typeof ref.factor !== "string" || !ID_RE.test(ref.factor)) return null;
    if (ref.weight !== undefined && (typeof ref.weight !== "number" || !Number.isFinite(ref.weight) || ref.weight < 0)) return null;
    factors.push({ factor: ref.factor, weight: ref.weight as number | undefined });
  }

  let criteria: LlmCriterion[] | undefined;
  if (r.criteria !== undefined) {
    if (!Array.isArray(r.criteria)) return null;
    const seen = new Set<string>();
    criteria = [];
    for (const c of r.criteria) {
      const crit = validCriterion(c, seen);
      // Reject a criterion whose id collides with a built-in/rule id — never shadow.
      if (!crit || reservedIds.has(crit.id)) return null;
      seen.add(crit.id);
      criteria.push(crit);
    }
  }

  return {
    id: r.id, title: r.title.trim(), target: r.target.trim(),
    naturalScope: r.naturalScope as RubricScopeKind | undefined,
    factors, criteria,
  };
}

/** Default rubrics dir (~/.agentgem/rubrics), honoring AGENTGEM_HOME via agentgemHome(). */
export function defaultRubricsDir(): string {
  return join(agentgemHome(), ".agentgem", "rubrics");
}

/**
 * Load every *.json rubric file from the rubrics dir (default ~/.agentgem/rubrics).
 * Files are read in sorted order; each may hold one rubric object or an array.
 * Invalid entries and ids colliding with a built-in or an earlier rubric are skipped.
 * `reservedFactorIds` should include built-in detector ids and loaded rule ids so an
 * inline criterion can't shadow them.
 */
export function loadRubrics(
  dir = defaultRubricsDir(),
  reservedFactorIds: ReadonlySet<string> = new Set(DETECTORS.map((d) => d.id)),
): Rubric[] {
  let files: string[];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort(); }
  catch { return []; }   // no dir = no rubrics — the common case
  const out: Rubric[] = [];
  const seen = new Set(builtinRubrics().map((r) => r.id));
  for (const f of files) {
    try {
      const raw: unknown = JSON.parse(readFileSync(join(dir, f), "utf8"));
      for (const entry of Array.isArray(raw) ? raw : [raw]) {
        const rubric = validateRubric(entry, reservedFactorIds);
        if (!rubric || seen.has(rubric.id)) continue;
        seen.add(rubric.id);
        out.push(rubric);
      }
    } catch (err) {
      log.warn("rubrics: skipped %s: %s", f, (err as Error)?.message ?? err);
    }
  }
  return out;
}

/**
 * Built-in rubrics — work day one with zero config. `hygiene` groups the three
 * built-in session-behavior detectors so today's implicit Insights detector pass
 * becomes an explicit, named rubric.
 */
export function builtinRubrics(): Rubric[] {
  return [
    {
      id: "hygiene",
      title: "Session hygiene",
      target: "overview",
      naturalScope: "project",
      factors: [
        { factor: "retry-storm" },
        { factor: "thrash-loop" },
        { factor: "no-verify-finish" },
      ],
    },
  ];
}

/** The granularity of one factor ref: an inline criterion's declared granularity, else "session". */
export function factorGranularity(ref: RubricFactorRef, rubric: Rubric): RubricGranularity {
  const crit = rubric.criteria?.find((c) => c.id === ref.factor);
  return crit?.granularity ?? "session";   // built-in detectors and rules are session-granular
}

/** A rubric is session-granular iff every factor is; otherwise aggregate. */
export function rubricGranularity(rubric: Rubric): RubricGranularity {
  return rubric.factors.every((f) => factorGranularity(f, rubric) === "session") ? "session" : "aggregate";
}

/**
 * Whether a rubric may run at a given scope. Hard rule: scope "session" requires a
 * session-granular rubric (an aggregate-only rubric has nothing to say about one
 * session). "project"/"all" accept either.
 */
export function scopeAllowed(rubric: Rubric, kind: RubricScopeKind): boolean {
  if (kind === "session") return rubricGranularity(rubric) === "session";
  return true;
}
