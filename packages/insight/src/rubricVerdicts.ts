// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/rubricVerdicts.ts
//
// The verdict record and its rollup math — types and pure functions only, no fs
// and no sqlite, so every counting rule is testable without a database. The store
// (rubricVerdictStore.ts) does IO and nothing else.
//
// A verdict is a person's call on one factor that fired against one session:
// `accepted` (real, acting on it), `wrong` (the factor mis-fired), or `wontfix`
// (it fired correctly, not acting). `wrong` and `wontfix` are deliberately NOT one
// value — `wrong` says the criterion is bad, `wontfix` says the criterion is right
// and its `advice` is not compelling. Those are different fixes, and one merged
// "dismissed" count answers neither question.
//
// Rows are append-only, so a pair can carry several rows and the latest wins.

/** A person's call on one fired factor. */
export type VerdictValue = "accepted" | "wrong" | "wontfix";

export const VERDICT_VALUES: readonly VerdictValue[] = ["accepted", "wrong", "wontfix"];

/** Max stored note length. Notes are human-authored and never leave the machine. */
export const NOTE_MAX = 500;

export interface RubricVerdict {
  sessionId: string;
  factorId: string;
  verdict: VerdictValue;
  note?: string;
  atMs: number;
  /** Part of the key. Inline criteria are rubric-local and user-authored, so the same
   *  factor id in two rubrics can mean two different things — scoping by rubric keeps
   *  their calibration apart (spec §1.4). */
  rubricId: string;
}

/**
 * All-time calibration for one factor WITHIN ONE RUBRIC. `reviewed` counts only keys
 * that carry a verdict — an untriaged fire is an unanswered question, never an
 * implicit pass.
 *
 * This is a false-positive rate and nothing more. It cannot see a criterion that
 * fails to fire when it should: no fire means no verdict, so a false negative leaves
 * no trace here. Never present it as accuracy.
 */
export interface FactorCalibration {
  reviewed: number;
  accepted: number;
  wrong: number;
  wontfix: number;
}

// Written as an escape, not a literal NUL byte, so the source stays greppable —
// a stray control byte makes grep classify the file as binary and skip it (40089570).
const SEP = "\u0000";

/**
 * The verdict key. Scoped by rubric because inline criteria are rubric-LOCAL:
 * validateRubric only rejects an inline id that collides with a built-in detector or
 * rule, so two user rubrics may each define `f1` with a different question. Merging
 * their verdicts would produce one number describing neither (spec §1.4).
 */
export function verdictKey(rubricId: string, sessionId: string, factorId: string): string {
  return `${rubricId}${SEP}${sessionId}${SEP}${factorId}`;
}

/**
 * Collapse append-only rows to the current verdict per key. `rows` MUST arrive in
 * ascending (atMs, id) order — the store's readers guarantee it — so a later row at
 * the same millisecond still wins.
 */
export function latestPerKey(rows: RubricVerdict[]): Map<string, RubricVerdict> {
  const out = new Map<string, RubricVerdict>();
  for (const r of rows) out.set(verdictKey(r.rubricId, r.sessionId, r.factorId), r);
  return out;
}

/**
 * Per-factor calibration over the current verdict of each pair. A factor with no
 * verdicts is ABSENT from the map rather than present with zeroes: the caller
 * renders nothing for an absent factor, and "0 wrong of 0 reviewed" would read as
 * a criterion nobody has ever disputed.
 */
export function foldCalibration(rows: RubricVerdict[]): Map<string, FactorCalibration> {
  const out = new Map<string, FactorCalibration>();
  for (const v of latestPerKey(rows).values()) {
    const c = out.get(v.factorId) ?? { reviewed: 0, accepted: 0, wrong: 0, wontfix: 0 };
    c.reviewed++;
    c[v.verdict]++;
    out.set(v.factorId, c);
  }
  return out;
}

/** The current verdict per factor, grouped by session — the shape the report's
 *  perSession rows carry so the console can render button state. */
export function verdictsBySession(rows: RubricVerdict[]): Map<string, Record<string, RubricVerdict>> {
  const out = new Map<string, Record<string, RubricVerdict>>();
  for (const v of latestPerKey(rows).values()) {
    const rec = out.get(v.sessionId) ?? {};
    rec[v.factorId] = v;
    out.set(v.sessionId, rec);
  }
  return out;
}