// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gemit/score.ts
//
// Deterministic steering-score core for `agentgem gemit`: pure aggregation from
// per-session inputs to the report card payload. No filesystem, no LLM — two
// runs over the same inputs produce the same card, which is what makes shared
// cards comparable. Session collection lives in ./collect.ts; rendering in
// ./themeRpg.ts.

export const WINDOW_DAYS = 30;
export const MIN_SESSIONS = 5;
export const MIN_MSGS = 10;
export const SAMPLE_CAP = 150;
export const TIER_THRESHOLDS = [50, 65, 80] as const;

export interface GemitSessionInput {
  sessionId: string;
  agent: string;
  endMs: number;
  msgs: number;
  tokensOut: number;
  skillNames: string[];
  subagentNames: string[];
  /** Skill name → invocation count (for top-skills ranking). */
  skillCounts?: Record<string, number>;
  subagentCounts?: Record<string, number>;
  /** Opaque distinct-project identity; counted, never emitted. */
  projectKey: string | null;
}

export interface GemitScoredInput {
  session: GemitSessionInput;
  hygieneScore: number | null;
  hygieneVerdict: "bounded" | "mixed" | "bloated" | null;
  processScore: number | null;
  processLabel: "disciplined" | "loose" | "chaotic" | null;
  /** Detector findings as reported — may include count:0 entries (unfired). */
  findings: Array<{ id: string; title: string; count: number }>;
  verifications: number | null;
}

export interface GemitData {
  windowFrom: string;
  windowTo: string;
  qualifyingSessions: number;
  scoredSessions: number;
  projects: number;
  totalMsgs: number;
  tokensOut: number;
  ctx: number;
  proc: number;
  setup: number;
  composite: number;
  tierLevel: 1 | 2 | 3 | 4;
  verdicts: { bounded: number; mixed: number; bloated: number };
  labels: { disciplined: number; loose: number; chaotic: number };
  verifyRatePct: number | null;
  boundedStreak: number;
  firedFindings: Array<{ id: string; title: string; sessions: number }>;
  skillVariety: number;
  subagentVariety: number;
  topSkills: string[];
  topSubagents: string[];
  insufficient: boolean;
}

export function tierLevelFor(composite: number): 1 | 2 | 3 | 4 {
  if (composite >= TIER_THRESHOLDS[2]) return 4;
  if (composite >= TIER_THRESHOLDS[1]) return 3;
  if (composite >= TIER_THRESHOLDS[0]) return 2;
  return 1;
}

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

// Recency weight: 1.0 now, linearly down to 0.5 at the window's far edge.
function recencyWeight(endMs: number, nowMs: number): number {
  const windowMs = WINDOW_DAYS * 24 * 3600 * 1000;
  const age = Math.min(Math.max(nowMs - endMs, 0), windowMs);
  return 0.5 + 0.5 * (1 - age / windowMs);
}

function weightedMean(pairs: Array<{ value: number; weight: number }>): number {
  const totalW = pairs.reduce((a, p) => a + p.weight, 0);
  if (totalW === 0) return 0;
  return pairs.reduce((a, p) => a + p.value * p.weight, 0) / totalW;
}

export function computeGemitData(
  qualifying: GemitSessionInput[],
  scored: GemitScoredInput[],
  nowMs: number,
): GemitData {
  const windowFrom = isoDay(nowMs - WINDOW_DAYS * 24 * 3600 * 1000);
  const windowTo = isoDay(nowMs);
  const projects = new Set(qualifying.map((s) => s.projectKey).filter(Boolean)).size;

  const base = {
    windowFrom,
    windowTo,
    qualifyingSessions: qualifying.length,
    scoredSessions: scored.length,
    projects,
    totalMsgs: qualifying.reduce((a, s) => a + s.msgs, 0),
    tokensOut: qualifying.reduce((a, s) => a + s.tokensOut, 0),
  };

  if (qualifying.length < MIN_SESSIONS) {
    return {
      ...base,
      ctx: 0, proc: 0, setup: 0, composite: 0, tierLevel: 1,
      verdicts: { bounded: 0, mixed: 0, bloated: 0 },
      labels: { disciplined: 0, loose: 0, chaotic: 0 },
      verifyRatePct: null, boundedStreak: 0, firedFindings: [],
      skillVariety: 0, subagentVariety: 0, topSkills: [], topSubagents: [],
      insufficient: true,
    };
  }

  // CTX / PROC — recency-weighted means over scored sessions that carry the signal.
  const ctx = weightedMean(
    scored.filter((r) => r.hygieneScore !== null)
      .map((r) => ({ value: r.hygieneScore as number, weight: recencyWeight(r.session.endMs, nowMs) })),
  );
  const proc = weightedMean(
    scored.filter((r) => r.processScore !== null)
      .map((r) => ({ value: r.processScore as number, weight: recencyWeight(r.session.endMs, nowMs) })),
  );

  const verdicts = { bounded: 0, mixed: 0, bloated: 0 };
  for (const r of scored) if (r.hygieneVerdict) verdicts[r.hygieneVerdict]++;
  const labels = { disciplined: 0, loose: 0, chaotic: 0 };
  for (const r of scored) if (r.processLabel) labels[r.processLabel]++;

  const withVerify = scored.filter((r) => r.verifications !== null);
  const verifyRatePct = withVerify.length
    ? Math.round((100 * withVerify.filter((r) => (r.verifications as number) > 0).length) / withVerify.length)
    : null;

  // Longest consecutive bounded run in chronological order.
  let streak = 0, boundedStreak = 0;
  for (const r of [...scored].sort((a, b) => a.session.endMs - b.session.endMs)) {
    if (r.hygieneVerdict === null) continue;
    streak = r.hygieneVerdict === "bounded" ? streak + 1 : 0;
    boundedStreak = Math.max(boundedStreak, streak);
  }

  // Fired findings: sessions where a detector actually fired (count > 0 — the
  // hygiene endpoint reports all five detectors with count 0 when unfired).
  const fired = new Map<string, { title: string; sessions: number }>();
  for (const r of scored) {
    const seen = new Set<string>();
    for (const f of r.findings) {
      if (!(f.count > 0) || seen.has(f.id)) continue;
      seen.add(f.id);
      const cur = fired.get(f.id) ?? { title: f.title, sessions: 0 };
      cur.sessions++;
      fired.set(f.id, cur);
    }
  }
  const firedFindings = [...fired.entries()]
    .map(([id, v]) => ({ id, title: v.title, sessions: v.sessions }))
    .sort((a, b) => b.sessions - a.sessions);

  // SETUP — harness usage over ALL qualifying sessions: presence × variety.
  const n = qualifying.length;
  const skillSessions = qualifying.filter((s) => s.skillNames.length > 0).length;
  const subagentSessions = qualifying.filter((s) => s.subagentNames.length > 0).length;
  const skillTotals = new Map<string, number>();
  const subagentTotals = new Map<string, number>();
  for (const s of qualifying) {
    for (const name of s.skillNames) skillTotals.set(name, (skillTotals.get(name) ?? 0) + (s.skillCounts?.[name] ?? 1));
    for (const name of s.subagentNames) subagentTotals.set(name, (subagentTotals.get(name) ?? 0) + (s.subagentCounts?.[name] ?? 1));
  }
  const skillVariety = skillTotals.size;
  const subagentVariety = subagentTotals.size;
  const setup = Math.round(100 * Math.min(1,
    0.45 * (skillSessions / n) + 0.25 * (subagentSessions / n) +
    0.15 * Math.min(1, skillVariety / 10) + 0.15 * Math.min(1, subagentVariety / 5)));

  const top = (m: Map<string, number>, cap: number): string[] =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, cap).map(([name]) => name);

  const ctxR = Math.round(ctx);
  const procR = Math.round(proc);
  const composite = Math.round(0.4 * ctxR + 0.4 * procR + 0.2 * setup);

  return {
    ...base,
    ctx: ctxR, proc: procR, setup, composite,
    tierLevel: tierLevelFor(composite),
    verdicts, labels, verifyRatePct, boundedStreak, firedFindings,
    skillVariety, subagentVariety,
    topSkills: top(skillTotals, 12), topSubagents: top(subagentTotals, 8),
    insufficient: false,
  };
}
