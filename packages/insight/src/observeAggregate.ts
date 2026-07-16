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
  cwd?: string | null;      // full session cwd when the source records it (used for repo-owner attribution)
  model: string | null;
  gitBranch: string | null; // top-level gitBranch from Claude records; null for Codex
  startMs: number;
  endMs: number;
  msgs: number;
  tokensIn: number;         // fresh input (cache excluded)
  tokensOut: number;        // output (+ reasoning for codex)
  tokensCache: number;      // cache read+creation (claude) / cached_input (codex)
  // Per-session usage counts, captured cheaply during the same transcript walk that
  // computes tokens/msgs. Optional — older/partial stats omit them.
  tools?: Record<string, number>;      // tool_use / function_call name → count
  skills?: Record<string, number>;     // skill name (from the Skill tool) → count
  subagents?: Record<string, number>;  // subagent_type (from the Task tool) → count
}

export type ObserveRange = "today" | "7d" | "30d" | "all";

export interface ObserveFilter { agent?: string; project?: string; model?: string; minMsgs?: number }

export interface ObservePayload {
  pulse: { sessions: number; msgs: number; tokens: number; activeMs: number };
  daily: { date: string; sessions: number; msgs: number; tokensIn: number; tokensOut: number; tokensCache: number }[];
  sessions: { agent: AgentId; sessionId: string; project: string | null; model: string | null; startMs: number; endMs: number; durationMs: number; msgs: number; tokens: number; tokensIn: number; tokensOut: number; tokensCache: number; gitBranch: string | null }[];
  models: { model: string; agent: AgentId; sessions: number; tokens: number }[];
  // Usage breakdowns across the filtered sessions, desc by count (empty when unavailable).
  byTool: { name: string; count: number }[];
  bySkill: { name: string; count: number }[];
  bySubagent: { name: string; count: number }[];
  // Per-day usage series for charting. Each day holds only the top-6 names of each
  // dimension (bounded payload); same UTC-date axis as `daily`.
  usageDaily: { date: string; tools: Record<string, number>; skills: Record<string, number>; subagents: Record<string, number> }[];
  // Token attribution over the UNCAPPED filtered set (the `sessions` array below is
  // recency-capped at 200 — deriving these client-side from it would silently
  // truncate). byProject is a PARTIAL-FILTER aggregate: agent/model/minMsgs apply,
  // the project filter does NOT — the Tokens-by-project card keeps its full ranking
  // while a project filter is active (Variant B). `project` stays null for the
  // unassigned bucket; labeling is the renderer's job.
  byProject: { project: string | null; sessions: number; tokens: number; tokensIn: number; tokensOut: number; tokensCache: number }[];
  topSessions: { agent: AgentId; sessionId: string; project: string | null; model: string | null; tokens: number; tokensIn: number; tokensOut: number; tokensCache: number; endMs: number }[];
  facets: { agents: string[]; projects: string[]; models: string[] };
  range: ObserveRange;
}

/** Fold a per-session count map into a running total map. */
function addCounts(into: Map<string, number>, from: Record<string, number> | undefined): void {
  if (!from) return;
  for (const [k, v] of Object.entries(from)) into.set(k, (into.get(k) ?? 0) + v);
}
const rankCounts = (m: Map<string, number>) =>
  [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);

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

  // Apply attribute filters. byProject deliberately skips the project filter — a
  // partial-filter aggregate (cousin of `facets` above, which skips ALL filters).
  let attrFiltered = rangeStats;
  if (filter?.agent !== undefined) attrFiltered = attrFiltered.filter((s) => s.agent === filter.agent);
  if (filter?.model !== undefined) attrFiltered = attrFiltered.filter((s) => s.model === filter.model);
  if (filter?.minMsgs !== undefined) attrFiltered = attrFiltered.filter((s) => s.msgs >= filter.minMsgs!);
  const filtered = filter?.project !== undefined
    ? attrFiltered.filter((s) => s.project === filter.project)
    : attrFiltered;

  const byDay = new Map<string, ObservePayload["daily"][number]>();
  const byModel = new Map<string, ObservePayload["models"][number]>();
  const byTool = new Map<string, number>(), bySkill = new Map<string, number>(), bySubagent = new Map<string, number>();
  // Full per-day per-artifact counts; trimmed to each dimension's top-6 after ranking.
  const fullDay = new Map<string, { tools: Map<string, number>; skills: Map<string, number>; subagents: Map<string, number> }>();
  let pTokens = 0, pMsgs = 0, pActive = 0;
  for (const s of filtered) {
    addCounts(byTool, s.tools);
    addCounts(bySkill, s.skills);
    addCounts(bySubagent, s.subagents);
    const date = utcDate(s.startMs);
    const d = byDay.get(date) ?? { date, sessions: 0, msgs: 0, tokensIn: 0, tokensOut: 0, tokensCache: 0 };
    d.sessions++; d.msgs += s.msgs; d.tokensIn += s.tokensIn; d.tokensOut += s.tokensOut; d.tokensCache += s.tokensCache;
    byDay.set(date, d);

    const fd = fullDay.get(date) ?? { tools: new Map(), skills: new Map(), subagents: new Map() };
    addCounts(fd.tools, s.tools); addCounts(fd.skills, s.skills); addCounts(fd.subagents, s.subagents);
    fullDay.set(date, fd);

    const modelKey = `${s.agent}:${s.model ?? "unknown"}`;
    const m = byModel.get(modelKey) ?? { model: s.model ?? "unknown", agent: s.agent, sessions: 0, tokens: 0 };
    m.sessions++; m.tokens += tokensOf(s);
    byModel.set(modelKey, m);

    pTokens += tokensOf(s); pMsgs += s.msgs; pActive += Math.max(0, s.endMs - s.startMs);
  }

  const byProj = new Map<string | null, ObservePayload["byProject"][number]>();
  for (const s of attrFiltered) {
    const b = byProj.get(s.project) ??
      { project: s.project, sessions: 0, tokens: 0, tokensIn: 0, tokensOut: 0, tokensCache: 0 };
    b.sessions++; b.tokens += tokensOf(s);
    b.tokensIn += s.tokensIn; b.tokensOut += s.tokensOut; b.tokensCache += s.tokensCache;
    byProj.set(s.project, b);
  }
  const byProject = [...byProj.values()].sort((a, b) => b.tokens - a.tokens);

  const topSessions = [...filtered]
    .sort((a, b) => tokensOf(b) - tokensOf(a))
    .slice(0, 8)
    .map((s) => ({
      agent: s.agent, sessionId: s.sessionId, project: s.project, model: s.model,
      tokens: tokensOf(s), tokensIn: s.tokensIn, tokensOut: s.tokensOut, tokensCache: s.tokensCache,
      endMs: s.endMs,
    }));

  const USAGE_TOP = 6;
  const byToolR = rankCounts(byTool), bySkillR = rankCounts(bySkill), bySubagentR = rankCounts(bySubagent);
  const top = (r: { name: string }[]) => r.slice(0, USAGE_TOP).map((x) => x.name);
  const topT = top(byToolR), topS = top(bySkillR), topA = top(bySubagentR);
  const pick = (m: Map<string, number>, names: string[]): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const n of names) { const v = m.get(n); if (v !== undefined) out[n] = v; }
    return out;
  };
  const usageDaily = [...fullDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, fd]) => ({ date, tools: pick(fd.tools, topT), skills: pick(fd.skills, topS), subagents: pick(fd.subagents, topA) }));

  return {
    pulse: { sessions: filtered.length, msgs: pMsgs, tokens: pTokens, activeMs: pActive },
    daily: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
    sessions: filtered
      .map((s) => ({ agent: s.agent, sessionId: s.sessionId, project: s.project, model: s.model, startMs: s.startMs, endMs: s.endMs, durationMs: Math.max(0, s.endMs - s.startMs), msgs: s.msgs, tokens: tokensOf(s), tokensIn: s.tokensIn, tokensOut: s.tokensOut, tokensCache: s.tokensCache, gitBranch: s.gitBranch }))
      .sort((a, b) => b.endMs - a.endMs)
      .slice(0, 200),
    models: [...byModel.values()].sort((a, b) => b.tokens - a.tokens),
    byTool: byToolR,
    bySkill: bySkillR,
    bySubagent: bySubagentR,
    usageDaily,
    byProject,
    topSessions,
    facets,
    range,
  };
}
