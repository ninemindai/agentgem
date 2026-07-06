// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/contextHygiene.ts
//
// Context-hygiene detector family: flags a session dragging many unrelated tasks
// into one ever-growing window (vs. a bounded-but-long session, which is fine).
// Same house pattern as the shipped detectors — pure SessionSequence -> findings,
// degrade to [] on missing data, detail from counts/verbs only (never arg).
import type { DetectorSpec, DetectorFinding } from "./detectors.js";
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
