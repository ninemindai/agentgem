// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/observeScan.ts
//
// Deterministic transcript → SessionStat. Walks the local Claude + Codex session
// stores and normalizes each session into one usage/timing record. Privacy
// boundary: reads usage, timestamps, model, type, cwd/id ONLY — never message
// text (mirrors workflowScan.ts). Total functions: missing dirs / malformed
// lines degrade to empty/skip, never throw.
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { resolveDirs } from "@agentgem/model";

export interface SessionStat {
  agent: "claude" | "codex";
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

function* jsonLines(text: string): Generator<Record<string, unknown>> {
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line) as Record<string, unknown>; } catch { /* skip malformed */ }
  }
}

function listFiles(dir: string, suffix: string): string[] {
  const out: string[] = [];
  let entries: import("node:fs").Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, suffix));
    else if (e.name.endsWith(suffix)) out.push(p);
  }
  return out;
}

export function parseClaudeTranscript(text: string, path: string): SessionStat | null {
  // Fix 1: canonical sessionId comes from the transcript filename (the UUID), not inline record fields.
  // Subagent/sidechain records carry a shared parent sessionId which would cause collisions.
  const sessionId = basename(path).replace(/\.jsonl$/, "");
  let cwd: string | null = null, model: string | null = null, gitBranch: string | null = null;
  let startMs = Infinity, endMs = -Infinity, msgs = 0, tokensIn = 0, tokensOut = 0, tokensCache = 0;
  for (const rec of jsonLines(text)) {
    const type = rec.type as string | undefined;
    if (typeof rec.cwd === "string") cwd = rec.cwd;
    if (typeof rec.gitBranch === "string" && rec.gitBranch) gitBranch = rec.gitBranch;
    const ts = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
    if (!Number.isNaN(ts)) { startMs = Math.min(startMs, ts); endMs = Math.max(endMs, ts); }
    if (type === "user" || type === "assistant") msgs++;
    const msg = rec.message as Record<string, unknown> | undefined;
    // Fix 2: skip the <synthetic> sentinel — it is not a real model name.
    if (msg && typeof msg.model === "string" && msg.model !== "<synthetic>") model = msg.model;
    const u = msg?.usage as Record<string, number> | undefined;
    if (u) {
      tokensIn += u.input_tokens ?? 0;
      tokensOut += u.output_tokens ?? 0;
      tokensCache += (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    }
  }
  if (!sessionId || endMs < startMs) return null;
  return { agent: "claude", sessionId, project: cwd ? basename(cwd) : null, model, gitBranch, startMs, endMs, msgs, tokensIn, tokensOut, tokensCache };
}

export function parseCodexTranscript(text: string, path: string): SessionStat | null {
  let sessionId = "", cwd: string | null = null, model: string | null = null;
  let startMs = Infinity, endMs = -Infinity, msgs = 0;
  let total: Record<string, number> | null = null;   // cumulative; keep the last seen
  for (const rec of jsonLines(text)) {
    const ts = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
    if (!Number.isNaN(ts)) { startMs = Math.min(startMs, ts); endMs = Math.max(endMs, ts); }
    const payload = rec.payload as Record<string, unknown> | undefined;
    if (rec.type === "session_meta" && payload) {
      if (typeof payload.id === "string") sessionId = payload.id;
      if (typeof payload.cwd === "string") cwd = payload.cwd;
    }
    if (payload && typeof payload.model === "string") model = payload.model;     // best-effort (turn_context)
    if (rec.type === "response_item" && (payload?.type === "message")) msgs++;
    if (rec.type === "event_msg" && payload?.type === "token_count") {
      const info = payload.info as Record<string, unknown> | undefined;
      const tu = info?.total_token_usage as Record<string, number> | undefined;
      if (tu) total = tu;
    }
  }
  if (!sessionId || endMs < startMs) return null;
  const input = total?.input_tokens ?? 0, cached = total?.cached_input_tokens ?? 0;
  const tokensIn = Math.max(0, input - cached);
  const tokensOut = (total?.output_tokens ?? 0) + (total?.reasoning_output_tokens ?? 0);
  return { agent: "codex", sessionId, project: cwd ? basename(cwd) : null, model, gitBranch: null, startMs, endMs, msgs, tokensIn, tokensOut, tokensCache: cached };
}

export type ObserveRange = "today" | "7d" | "30d" | "all";

export interface ObserveFilter { agent?: string; project?: string; model?: string; minMsgs?: number }

export interface ObservePayload {
  pulse: { sessions: number; msgs: number; tokens: number; activeMs: number };
  daily: { date: string; sessions: number; msgs: number; tokensIn: number; tokensOut: number; tokensCache: number }[];
  sessions: { agent: "claude" | "codex"; sessionId: string; project: string | null; model: string | null; startMs: number; endMs: number; durationMs: number; msgs: number; tokens: number; tokensIn: number; tokensOut: number; tokensCache: number; gitBranch: string | null }[];
  models: { model: string; agent: "claude" | "codex"; sessions: number; tokens: number }[];
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

let _cache: { atMs: number; stats: SessionStat[] } | null = null;
const SCAN_TTL_MS = 15_000;
/** Cached scan for the request path: re-scans at most every SCAN_TTL_MS. nowMs injected for testability.
 *  Fix 4: when custom dirs are provided the result is never cached — only the default path is cacheable. */
export async function scanSessionsCached(nowMs: number, dirs?: { claudeDir?: string; codexDir?: string }): Promise<SessionStat[]> {
  if (dirs) return scanSessions(dirs);                       // custom dirs are never cached
  if (_cache && nowMs - _cache.atMs < SCAN_TTL_MS) return _cache.stats;
  const stats = await scanSessions();
  _cache = { atMs: nowMs, stats };
  return stats;
}
/** Test seam: drop the cache. */
export function clearScanCache(): void { _cache = null; }

export async function scanSessions(dirs?: { claudeDir?: string; codexDir?: string }): Promise<SessionStat[]> {
  const resolved = resolveDirs();
  const claudeDir = dirs?.claudeDir ?? resolved.claudeDir;
  const codexDir = dirs?.codexDir ?? resolved.codexDir;
  const out: SessionStat[] = [];
  for (const f of listFiles(join(claudeDir, "projects"), ".jsonl")) {
    let text: string; try { text = await readFile(f, "utf8"); } catch { continue; }
    const s = parseClaudeTranscript(text, f); if (s) out.push(s);
  }
  for (const f of listFiles(join(codexDir, "sessions"), ".jsonl")) {
    if (!basename(f).startsWith("rollout-")) continue;   // skip history.jsonl etc.
    let text: string; try { text = await readFile(f, "utf8"); } catch { continue; }
    const s = parseCodexTranscript(text, f); if (s) out.push(s);
  }
  return out;
}
