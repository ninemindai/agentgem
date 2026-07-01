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
// The pure aggregation half (SessionStat + aggregateObserve + payload types) lives
// in observeAggregate.ts so the browser can share it; re-export so existing
// `@agentgem/insight` consumers of these names keep resolving.
import type { SessionStat } from "./observeAggregate.js";
export type { SessionStat, ObserveRange, ObserveFilter, ObservePayload, AgentId } from "./observeAggregate.js";
export { aggregateObserve } from "./observeAggregate.js";

// Exported for reuse by the on-demand transcript read path (inspectSession.ts),
// which walks the same Claude/Codex stores but emits content trees, not metadata.
export function* jsonLines(text: string): Generator<Record<string, unknown>> {
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line) as Record<string, unknown>; } catch { /* skip malformed */ }
  }
}

export function listFiles(dir: string, suffix: string): string[] {
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

let _cache: { atMs: number; stats: SessionStat[] } | null = null;
const SCAN_TTL_MS = 15_000;
/** Cached scan for the request path: re-scans at most every SCAN_TTL_MS. nowMs injected for testability.
 *  Fix 4: when custom dirs are provided the result is never cached — only the default path is cacheable.
 *  refresh (the ?fresh=1 bypass) forces a re-scan even within the TTL and repopulates the cache. */
export async function scanSessionsCached(nowMs: number, dirs?: { claudeDir?: string; codexDir?: string }, refresh = false): Promise<SessionStat[]> {
  if (dirs) return scanSessions(dirs);                       // custom dirs are never cached
  if (!refresh && _cache && nowMs - _cache.atMs < SCAN_TTL_MS) return _cache.stats;
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
