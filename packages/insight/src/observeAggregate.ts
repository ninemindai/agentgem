// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/observeAggregate.ts
//
// The PURE half of Inspect: SessionStat → ObservePayload. No node builtins, no
// imports — so the browser console can bundle aggregateObserve and derive every
// range/filter view client-side from one raw scan, sharing this exact logic with
// the server (which still calls it after scanning). Keep it dependency-free.

/** Open, registry-derived agent identity. Runtime validity is the SourceRegistry's concern;
 *  the type stays `string` so the pure aggregation layer needs no registry dependency. */
export type AgentId = string;

export interface SessionStat {
  agent: AgentId;
  sessionId: string;
  project: string | null;   // basename of session cwd, or null
  model: string | null;
  gitBranch: string | null; // top-level gitBranch from Claude records; null for Codex
  startMs: number;
  endMs: number;
  msgs: number;
  tokensIn: number;         // fresh input (cache excluded)
  tokensOut: number;        // output (+ reasoning for codex)
  tokensCache: number;      // cache read+creation (claude) / cached_input (codex)
}

export type ObserveRange = "today" | "7d" | "30d" | "all";

export interface ObserveFilter { agent?: string; project?: string; model?: string; minMsgs?: number }

export interface ObservePayload {
  pulse: { sessions: number; msgs: number; tokens: number; activeMs: number };
  daily: { date: string; sessions: number; msgs: number; tokensIn: number; tokensOut: number; tokensCache: number }[];
  sessions: { agent: AgentId; sessionId: string; project: string | null; model: string | null; startMs: number; endMs: number; durationMs: number; msgs: number; tokens: number; tokensIn: number; tokensOut: number; tokensCache: number; gitBranch: string | null }[];
  models: { model: string; agent: AgentId; sessions: number; tokens: number }[];
  facets: { agents: string[]; projects: string[]; models: string[] };
  range: ObserveRange;
}

const DAY_MS = 86_400_000;
const tokensOf = (s: SessionStat) => s.tokensIn + s.tokensOut + s.tokensCache;
const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function sinceMs(range: ObserveRange, nowMs: number): number {
  if (range === "all") return -Infinity;
  if (range === "today") return Date.parse(utcDate(nowMs) + "T00:00:00.000Z");
  return nowMs - (range === "7d" ? 7 : 30) * DAY_MS;
}

export function aggregateObserve(stats: SessionStat[], range: ObserveRange, nowMs: number, filter?: ObserveFilter): ObservePayload {
  const since = sinceMs(range, nowMs);
  const rangeStats = stats.filter((s) => s.endMs >= since);

  // Facets computed from rangeStats BEFORE attribute filters.
  const facets: ObservePayload["facets"] = {
    agents: [...new Set(rangeStats.map((s) => s.agent))].sort(),
    projects: [...new Set(rangeStats.map((s) => s.project).filter((p): p is string => p !== null))].sort(),
    models: [...new Set(rangeStats.map((s) => s.model).filter((m): m is string => m !== null))].sort(),
  };

  // Apply attribute filters.
  let filtered = rangeStats;
  if (filter?.agent !== undefined) filtered = filtered.filter((s) => s.agent === filter.agent);
  if (filter?.project !== undefined) filtered = filtered.filter((s) => s.project === filter.project);
  if (filter?.model !== undefined) filtered = filtered.filter((s) => s.model === filter.model);
  if (filter?.minMsgs !== undefined) filtered = filtered.filter((s) => s.msgs >= filter.minMsgs!);

  const byDay = new Map<string, ObservePayload["daily"][number]>();
  const byModel = new Map<string, ObservePayload["models"][number]>();
  let pTokens = 0, pMsgs = 0, pActive = 0;
  for (const s of filtered) {
    const date = utcDate(s.startMs);
    const d = byDay.get(date) ?? { date, sessions: 0, msgs: 0, tokensIn: 0, tokensOut: 0, tokensCache: 0 };
    d.sessions++; d.msgs += s.msgs; d.tokensIn += s.tokensIn; d.tokensOut += s.tokensOut; d.tokensCache += s.tokensCache;
    byDay.set(date, d);

    const modelKey = `${s.agent}:${s.model ?? "unknown"}`;
    const m = byModel.get(modelKey) ?? { model: s.model ?? "unknown", agent: s.agent, sessions: 0, tokens: 0 };
    m.sessions++; m.tokens += tokensOf(s);
    byModel.set(modelKey, m);

    pTokens += tokensOf(s); pMsgs += s.msgs; pActive += Math.max(0, s.endMs - s.startMs);
  }

  return {
    pulse: { sessions: filtered.length, msgs: pMsgs, tokens: pTokens, activeMs: pActive },
    daily: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
    sessions: filtered
      .map((s) => ({ agent: s.agent, sessionId: s.sessionId, project: s.project, model: s.model, startMs: s.startMs, endMs: s.endMs, durationMs: Math.max(0, s.endMs - s.startMs), msgs: s.msgs, tokens: tokensOf(s), tokensIn: s.tokensIn, tokensOut: s.tokensOut, tokensCache: s.tokensCache, gitBranch: s.gitBranch }))
      .sort((a, b) => b.endMs - a.endMs)
      .slice(0, 200),
    models: [...byModel.values()].sort((a, b) => b.tokens - a.tokens),
    facets,
    range,
  };
}
