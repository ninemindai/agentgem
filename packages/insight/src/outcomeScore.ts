// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Proven-use scoring primitives. Two consumers share one credit mapping:
//   - outcomeScore() aggregates MANY outcomes for one artifact (future
//     recommender consumer): sum credits, then Wilson-shrink so a lucky 2/2
//     cannot outrank a proven 40/45.
//   - recall (the v1 consumer) maps a SINGLE session's own outcome through
//     outcomeCredit() directly — no aggregation, so no Wilson.
// Pure; no I/O.

export type Outcome = "mostly_achieved" | "partially_achieved" | "not_achieved";

// A partial success counts as half. Named so it is tunable once the validation
// instrument reports; not a magic number.
export const PARTIAL_CREDIT = 0.5;

/** One outcome → its success credit in [0,1]. The single definition both the
 *  aggregate score and recall's per-session boost map through. */
export function outcomeCredit(o: Outcome): number {
  return o === "mostly_achieved" ? 1 : o === "partially_achieved" ? PARTIAL_CREDIT : 0;
}

/** Wilson score interval lower bound at confidence z (default 95%). n=0 → 0. */
export function wilsonLowerBound(successes: number, n: number, z = 1.96): number {
  if (n <= 0) return 0;
  const phat = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);
  return (centre - margin) / denom;
}

/** Aggregate an artifact's outcomes into one Wilson-shrunk score in [0,1].
 *  Foundation for the future recommender consumer; NOT on recall's path. */
export function outcomeScore(outcomes: Outcome[]): number {
  const n = outcomes.length;
  if (n === 0) return 0;
  const successes = outcomes.reduce((s, o) => s + outcomeCredit(o), 0);
  return wilsonLowerBound(successes, n);
}
