// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gemit/themeRpgSim.ts
//
// Pure simulation math for the rpg theme's Training Grounds. projectComposite /
// tierFor / autoSolvePath are serialized into the report page via
// Function.prototype.toString() — we ship plain tsc output (never minified), so
// the source survives verbatim; gemitSim.test.ts revives them the same way the
// page does and asserts identical results. Serialization rules: no imports, no
// module-level refs, no closures; they MAY call each other by name (revived into
// one shared scope). setupScoreFrom is render-time only (not serialized).

export interface SimWeights { ctx: number; proc: number; setup: number }

export function projectComposite(ctx: number, proc: number, setup: number, w: SimWeights): number {
  return Math.round(w.ctx * ctx + w.proc * proc + w.setup * setup);
}

export function tierFor(composite: number, thresholds: readonly number[]): 1 | 2 | 3 | 4 {
  if (composite >= thresholds[2]) return 4;
  if (composite >= thresholds[1]) return 3;
  if (composite >= thresholds[0]) return 2;
  return 1;
}

// Smallest total axis-point increase that reaches `targetTier`, spending points on
// the highest-weight axes first (they buy the most composite per axis point).
// Clamps to 100 per axis; unreachable targets saturate at all-100.
export function autoSolvePath(
  cur: { ctx: number; proc: number; setup: number },
  targetTier: number,
  w: SimWeights,
  thresholds: readonly number[],
): { ctx: number; proc: number; setup: number } {
  const target = targetTier <= 1 ? 0 : thresholds[targetTier - 2];
  const out = { ctx: cur.ctx, proc: cur.proc, setup: cur.setup };
  const axes = (["ctx", "proc", "setup"] as Array<"ctx" | "proc" | "setup">)
    .sort((a, b) => w[b] - w[a]);
  for (const k of axes) {
    if (projectComposite(out.ctx, out.proc, out.setup, w) >= target) break;
    const raw = w.ctx * out.ctx + w.proc * out.proc + w.setup * out.setup;
    out[k] = Math.min(100, out[k] + Math.ceil((target - 0.5 - raw) / w[k]));
  }
  // round() can leave the projection a point short of the threshold — top up cheaply.
  for (const k of axes) {
    while (projectComposite(out.ctx, out.proc, out.setup, w) < target && out[k] < 100) out[k]++;
  }
  return out;
}

export interface SetupWeightsShape { sessions: number; subSessions: number; variety: number; subVariety: number }
export interface SetupFieldsShape { skillSessionsPct: number; subagentSessionsPct: number; skillVariety: number; subagentVariety: number }

// Mirrors score.ts's SETUP formula from the payload's aggregate fields; exact when the
// percents are exact (cross-checked against computeGemitData in gemitSim.test.ts).
export function setupScoreFrom(f: SetupFieldsShape, sw: SetupWeightsShape): number {
  return Math.round(100 * Math.min(1,
    sw.sessions * (f.skillSessionsPct / 100) + sw.subSessions * (f.subagentSessionsPct / 100) +
    sw.variety * Math.min(1, f.skillVariety / 10) + sw.subVariety * Math.min(1, f.subagentVariety / 5)));
}
