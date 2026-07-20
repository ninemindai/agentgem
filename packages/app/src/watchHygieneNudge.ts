// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/watchHygieneNudge.ts
//
// Pure logic for the live Watch hygiene nudge. nudgeTransition fires ONLY when a
// session's verdict climbs to a heavier level — the anti-doomscroll core: it can
// never nag a bounded session, and re-arms naturally after a drop. buildTickEvents
// assembles the per-mtime-tick SSE payloads (a live snapshot always; a nudge on a
// climb) from a #161 HygieneReport. No I/O.
import type { HygieneReport } from "./sessionHygieneCore.js";

export type Verdict = "bounded" | "mixed" | "bloated";
const RANK: Record<Verdict, number> = { bounded: 0, mixed: 1, bloated: 2 };

export function nudgeTransition(prev: Verdict | null, next: Verdict): "fire" | "silent" {
  if (next === "bounded") return "silent";
  if (prev === null) return "fire";
  return RANK[next] > RANK[prev] ? "fire" : "silent";
}

export const CURVE_TAIL_MAX = 120;

const GENERIC_ADVICE = "This session's context is heavy — a clean break keeps it sharp.";

export interface TickEvents {
  hygiene: { verdict: Verdict; score: number; cap: number; curveTail: HygieneReport["curve"]; factors: HygieneReport["factors"] };
  nudge?: { verdict: Verdict; advice: string };
  nextVerdict: Verdict;
}

export function buildTickEvents(prev: Verdict | null, report: HygieneReport): TickEvents {
  const verdict = report.hygiene.verdict as Verdict;
  const curveTail = report.curve.slice(-CURVE_TAIL_MAX);
  const out: TickEvents = {
    hygiene: { verdict, score: report.hygiene.score, cap: report.meta.cap, curveTail, factors: report.factors },
    nextVerdict: verdict,
  };
  if (nudgeTransition(prev, verdict) === "fire") {
    const fired = report.factors.filter((f) => f.count > 0);
    const advice = fired[0]?.advice || GENERIC_ADVICE;
    out.nudge = { verdict, advice };
  }
  return out;
}
