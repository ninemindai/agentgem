// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/boundarySegments.ts
//
// Deterministic task-episode segmentation of one session: a change-point pass over
// the clusterOf(arg) sequence, smoothed, aligned to the bloat curve. Yields the task
// episodes (turn ranges -> cluster label) and the single best cut turn (the episode
// boundary with the largest context climb across it). Pure: no fs, no LLM, no I/O.
// The primary cluster source is file-path steps; pathless Bash carries forward (see
// the boundary-judge spec). Constants are exported and tunable in one place.
import type { SessionSequence } from "./workflowScan.js";
import { clusterOf } from "./taskCluster.js";

export interface BoundarySegment { fromTurn: number; toTurn: number; label: string }
export interface SessionBoundary { segments: BoundarySegment[]; cutTurn: number | null }

export const SMOOTH_W = 2;      // ±window (turns) for dominant-cluster smoothing of ping-pong blips
export const MIN_EPISODE = 3;   // episodes shorter than this (turns) are merged into a neighbor

export function boundarySegments(session: SessionSequence): SessionBoundary {
  const series = session.contextSeries ?? [];
  const N = series.length;
  if (N === 0) return { segments: [], cutTurn: null };

  // 1. turn -> cluster. series is ascending by msgIndex (turn order); a step aligns to
  //    the last series turn whose msgIndex <= step.msgIndex. Last non-null wins per turn.
  const turnCluster: (string | null)[] = new Array(N).fill(null);
  const steps = [...session.steps].sort((a, b) => a.msgIndex - b.msgIndex);
  let si = 0;
  for (const st of steps) {
    while (si + 1 < N && series[si + 1].msgIndex <= st.msgIndex) si++;
    const c = clusterOf(st.arg);
    if (c) turnCluster[si] = c;
  }
  // carry forward, then back-fill leading nulls with the first known cluster
  let last: string | null = null;
  for (let i = 0; i < N; i++) { if (turnCluster[i] == null) turnCluster[i] = last; else last = turnCluster[i]; }
  const firstKnown = turnCluster.find((c) => c != null) ?? null;
  for (let i = 0; i < N && turnCluster[i] == null; i++) turnCluster[i] = firstKnown;

  // 2. smooth: dominant (mode) cluster in ±SMOOTH_W, collapsing single-turn detours
  const smoothed: (string | null)[] = turnCluster.map((cur, i) => {
    const counts = new Map<string, number>();
    for (let j = Math.max(0, i - SMOOTH_W); j <= Math.min(N - 1, i + SMOOTH_W); j++) {
      const c = turnCluster[j]; if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    let best = cur, bestN = 0;
    for (const [c, n] of counts) if (n > bestN) { best = c; bestN = n; }
    return best;
  });

  // 3. run-length encode into episodes
  const rle: BoundarySegment[] = [];
  for (let i = 0; i < N; i++) {
    const label = smoothed[i] ?? "";
    const prev = rle[rle.length - 1];
    if (prev && prev.label === label) prev.toTurn = i;
    else rle.push({ fromTurn: i, toTurn: i, label });
  }
  // 3b. merge sub-MIN_EPISODE episodes into the previous (or, if first, hand turns to next)
  const out: BoundarySegment[] = [];
  for (let k = 0; k < rle.length; k++) {
    const ep = rle[k];
    if (ep.toTurn - ep.fromTurn + 1 >= MIN_EPISODE) { out.push({ ...ep }); continue; }
    if (out.length) out[out.length - 1].toTurn = ep.toTurn;
    else if (k + 1 < rle.length) rle[k + 1].fromTurn = ep.fromTurn;
    else out.push({ ...ep });
  }
  // 3c. coalesce any now-adjacent same-label episodes
  const segments: BoundarySegment[] = [];
  for (const ep of out) {
    const prev = segments[segments.length - 1];
    if (prev && prev.label === ep.label) prev.toTurn = ep.toTurn;
    else segments.push({ ...ep });
  }

  // 4. cut = boundary with the largest context climb across it (post mean - pre mean)
  if (segments.length <= 1) return { segments, cutTurn: null };
  const mean = (from: number, to: number) => {
    let s = 0; for (let i = from; i <= to; i++) s += series[i].ctxTokens; return s / (to - from + 1);
  };
  let cutTurn = segments[1].fromTurn, best = -Infinity;
  for (let k = 1; k < segments.length; k++) {
    const climb = mean(segments[k].fromTurn, segments[k].toTurn) - mean(segments[k - 1].fromTurn, segments[k - 1].toTurn);
    if (climb > best) { best = climb; cutTurn = segments[k].fromTurn; }
  }
  return { segments, cutTurn };
}
