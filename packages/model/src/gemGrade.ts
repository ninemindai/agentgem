// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/model/src/gemGrade.ts

/** Bounds of the authoring-quality floor baked onto a gem (Gem.grade). */
export const GEM_GRADE_MIN = 1;
export const GEM_GRADE_MAX = 3;

/**
 * The authoring-quality FLOOR (1..3) for a gem, derived from its scorecard axes.
 * A gem with ≥1 high-confidence ("battle-tested") workflow floors at 2; one that is
 * also portable floors at 3. `breadth` is accepted for a future tweak but does not
 * raise the floor (breadth alone isn't quality). The final 1..5 stone rating blends
 * this floor with community stars client-side — this is only the floor.
 * `triggerPrecision` is an optional advisory input (route-confusion score, 0..1):
 * when present and < 0.5, a measured-but-poorly-routing gem can't float above the
 * minimum floor.
 */
export function scorecardFloor(sc: { breadth: number; battleTested: number; portable: number; triggerPrecision?: number }): number {
  let f = GEM_GRADE_MIN;
  if (sc.battleTested >= 1) f++;
  if (sc.portable >= 1) f++;
  f = Math.min(GEM_GRADE_MAX, Math.max(GEM_GRADE_MIN, f));
  if (sc.triggerPrecision !== undefined && sc.triggerPrecision < 0.5) f = GEM_GRADE_MIN;
  return f;
}
