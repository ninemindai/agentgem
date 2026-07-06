// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/contextHygiene.ts
//
// Context-hygiene detector family: flags a session dragging many unrelated tasks
// into one ever-growing window (vs. a bounded-but-long session, which is fine).
// Same house pattern as the shipped detectors — pure SessionSequence -> findings,
// degrade to [] on missing data, detail from counts/verbs only (never arg).
import type { DetectorSpec, DetectorFinding, DetectorSummary } from "./detectors.js";
import type { SessionSequence } from "./workflowScan.js";
import { clusterOf } from "./taskCluster.js";
import { contextCap } from "./contextCap.js";

function finding(
  id: string, severity: "info" | "warn", session: SessionSequence,
  detail: string, msgIndices: number[],
): DetectorFinding {
  return {
    detectorId: id, sessionId: session.sessionId, transcript: session.transcript,
    atMs: session.atMs, severity, detail, evidence: { msgIndices },
  };
}

// Distinct file-touching clusters in one session at/above this reads as sprawl.
export const SPRAWL_MIN = 5;
// Cluster transitions (ping-pong between tasks) at/above this reads as thrash.
export const SWITCH_MIN = 12;
// Same file re-read this many times = it fell out of context and got re-fetched.
export const REREAD_MIN = 3;

export const taskSprawl: DetectorSpec = {
  id: "task-sprawl", title: "Many tasks in one session", cost: "cheap", severity: "warn",
  advice: "This session touched several unrelated areas. Splitting each into its own session keeps every window lean.",
  detect(session) {
    const clusters = new Set<string>();
    const idx: number[] = [];
    for (const s of session.steps) {
      const c = clusterOf(s.arg);
      if (c) { clusters.add(c); idx.push(s.msgIndex); }
    }
    if (clusters.size < SPRAWL_MIN) return [];
    return [finding("task-sprawl", "warn", session,
      `${clusters.size} task clusters in one session`, idx.slice(0, 20))];
  },
};

export const taskPingpong: DetectorSpec = {
  id: "task-pingpong", title: "Ping-ponging between tasks", cost: "cheap", severity: "info",
  advice: "Work bounced between areas repeatedly. Finishing one before starting the next avoids re-loading context each switch.",
  detect(session) {
    const seq: { c: string; i: number }[] = [];
    for (const s of session.steps) { const c = clusterOf(s.arg); if (c) seq.push({ c, i: s.msgIndex }); }
    let switches = 0; const at: number[] = [];
    for (let k = 1; k < seq.length; k++) if (seq[k].c !== seq[k - 1].c) { switches++; at.push(seq[k].i); }
    if (switches < SWITCH_MIN) return [];
    const clusters = new Set(seq.map((e) => e.c)).size;
    return [finding("task-pingpong", "info", session,
      `${switches} switches across ${clusters} clusters`, at.slice(0, 20))];
  },
};

export const rereadChurn: DetectorSpec = {
  id: "reread-churn", title: "Re-reading files that fell out of context", cost: "cheap", severity: "info",
  advice: "Files were read repeatedly, a sign the window grew past what it can hold. A cleaner cut keeps them resident.",
  detect(session) {
    const counts = new Map<string, number[]>();
    for (const s of session.steps) {
      if (s.tool !== "Read" || !s.arg) continue;
      (counts.get(s.arg) ?? counts.set(s.arg, []).get(s.arg)!).push(s.msgIndex);
    }
    let files = 0, redundant = 0; const idx: number[] = [];
    for (const [, hits] of counts) if (hits.length >= REREAD_MIN) { files++; redundant += hits.length - 1; idx.push(...hits); }
    if (files === 0) return [];
    return [finding("reread-churn", "info", session,
      `${files} file(s) re-read ${REREAD_MIN}+ times (${redundant} redundant reads)`, idx.slice(0, 20))];
  },
};

// A turn is "pinned" above this fraction of the model's context cap.
export const PIN_LEVEL = 0.85;
// A session is flagged when at least this fraction of turns are pinned.
export const PIN_FRACTION = 0.9;
// Late-half cache re-creation this many times the early half = churn late.
export const CHURN_RATIO = 1.8;

export const contextPinned: DetectorSpec = {
  id: "context-pinned", title: "Window pinned at the context cap", cost: "cheap", severity: "warn",
  advice: "The window sat against its cap for most of the session, re-processing the whole history every turn. Cutting earlier keeps each turn cheap and sharp.",
  detect(session) {
    const series = session.contextSeries;
    if (!series || series.length < 4) return [];
    const cap = contextCap(session.model);
    const level = cap * PIN_LEVEL;
    const pinned = series.filter((t) => t.ctxTokens >= level);
    if (pinned.length / series.length < PIN_FRACTION) return [];
    return [finding("context-pinned", "warn", session,
      `pinned ${pinned.length}/${series.length} turns at ≥${Math.round(PIN_LEVEL * 100)}% cap`,
      pinned.slice(0, 20).map((t) => t.msgIndex))];
  },
};

export const cacheChurnLate: DetectorSpec = {
  id: "cache-churn-late", title: "Context churning hardest when fullest", cost: "cheap", severity: "warn",
  advice: "The window was torn down and rebuilt far more in the back half than the front, a degradation signature. A cleaner cut resets it.",
  detect(session) {
    const series = session.contextSeries;
    if (!series || series.length < 4) return [];
    const half = Math.floor(series.length / 2);
    const sum = (arr: typeof series) => arr.reduce((a, t) => a + t.cacheCreation, 0);
    const early = sum(series.slice(0, half));
    const late = sum(series.slice(half));
    if (early <= 0) return [];
    const ratio = late / early;
    if (ratio < CHURN_RATIO) return [];
    return [finding("cache-churn-late", "warn", session,
      `late cache re-creation ${ratio.toFixed(1)}× early`,
      series.slice(half).slice(0, 20).map((t) => t.msgIndex))];
  },
};

export interface HygieneVerdict { score: number; verdict: "bounded" | "mixed" | "bloated" }

// Weights: pinning and late churn are the strongest window-health signals;
// sprawl next; pingpong/reread are softer. Any fire deducts its weight once
// (this is a per-report roll-up over DetectorSummary, not per-occurrence).
const WEIGHTS: Record<string, number> = {
  "context-pinned": 22, "cache-churn-late": 18, "task-sprawl": 18, "task-pingpong": 12, "reread-churn": 8,
};

export function hygieneScore(summaries: DetectorSummary[]): HygieneVerdict {
  let score = 100;
  for (const s of summaries) if (s.count > 0 && WEIGHTS[s.id]) score -= WEIGHTS[s.id];
  score = Math.max(0, score);
  const verdict = score >= 72 ? "bounded" : score >= 48 ? "mixed" : "bloated";
  return { score, verdict };
}

// True when the rubric's factors include at least one context-hygiene factor —
// used to avoid emitting a vacuous "bounded/100" verdict for unrelated rubrics.
export function assessesHygiene(summaries: DetectorSummary[]): boolean {
  return summaries.some((s) => s.id in WEIGHTS);
}
