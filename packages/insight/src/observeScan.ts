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
import { join, basename, isAbsolute } from "node:path";
import { normalizeProjectRoot } from "@agentgem/model";
import { BUILTIN_SOURCES, type SourceSpec, clearParseCache } from "./sources.js";
import { transcriptToken } from "./analysisCache.js";
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

// --- per-session usage capture (tools / skills / subagents), folded into the scan walk ---
const bump = (rec: Record<string, number>, key: string | undefined): void => {
  if (key) rec[key] = (rec[key] ?? 0) + 1;
};
const firstString = (input: Record<string, unknown> | undefined, keys: string[]): string | undefined => {
  for (const k of keys) { const v = input?.[k]; if (typeof v === "string" && v) return v; }
  return undefined;
};
/** Spread only the non-empty usage maps, so tool-free sessions stay lean and back-compatible. */
const usageFields = (tools: Record<string, number>, skills: Record<string, number>, subagents: Record<string, number>) => ({
  ...(Object.keys(tools).length ? { tools } : {}),
  ...(Object.keys(skills).length ? { skills } : {}),
  ...(Object.keys(subagents).length ? { subagents } : {}),
});

// A cwd → project-root normalizer. The scan supplies a memoized one (a whole-store
// scan touches thousands of transcripts sharing a handful of cwds); direct callers
// get the plain resolver.
type Normalizer = (cwd: string) => string;

// Project = the git checkout containing the session cwd (worktrees and
// subdirectories fold into the main checkout), by name; raw cwd stays on the
// stat for attribution. Resolution walks the live filesystem, so cwds whose
// checkout is gone (e.g. a removed worktree) fall back to their own basename.
// Only ABSOLUTE cwds are normalized: a relative/empty cwd (common in imported
// foreign transcripts) would otherwise resolve against the server's own cwd and
// mislabel the session as the local project.
function projectLabel(cwd: string | null, normalize: Normalizer): string | null {
  if (!cwd) return null;
  return isAbsolute(cwd) ? basename(normalize(cwd)) : basename(cwd);
}

export function parseClaudeTranscript(text: string, path: string, normalize: Normalizer = normalizeProjectRoot): SessionStat | null {
  // Fix 1: canonical sessionId comes from the transcript filename (the UUID), not inline record fields.
  // Subagent/sidechain records carry a shared parent sessionId which would cause collisions.
  const sessionId = basename(path).replace(/\.jsonl$/, "");
  let cwd: string | null = null, model: string | null = null, gitBranch: string | null = null;
  let startMs = Infinity, endMs = -Infinity, msgs = 0, tokensIn = 0, tokensOut = 0, tokensCache = 0;
  const tools: Record<string, number> = {}, skills: Record<string, number> = {}, subagents: Record<string, number> = {};
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
    // Tool usage lives in assistant message content items; Skill/Task carry the specific
    // skill name / subagent type in their input.
    if (type === "assistant" && Array.isArray(msg?.content)) {
      for (const raw of msg.content as unknown[]) {
        const it = raw as Record<string, unknown>;
        if (it.type !== "tool_use" || typeof it.name !== "string") continue;
        tools[it.name] = (tools[it.name] ?? 0) + 1;
        const input = it.input as Record<string, unknown> | undefined;
        if (it.name === "Skill") bump(skills, firstString(input, ["skill", "command", "name"]));
        // Subagents are spawned via the Task tool (classic) or the Agent tool (this harness).
        else if (it.name === "Task" || it.name === "Agent") bump(subagents, firstString(input, ["subagent_type", "subagentType"]));
      }
    }
  }
  if (!sessionId || endMs < startMs) return null;
  return { agent: "claude", sessionId, project: projectLabel(cwd, normalize), cwd, model, gitBranch, startMs, endMs, msgs, tokensIn, tokensOut, tokensCache, ...usageFields(tools, skills, subagents) };
}

export function parseCodexTranscript(text: string, path: string, normalize: Normalizer = normalizeProjectRoot): SessionStat | null {
  let sessionId = "", cwd: string | null = null, model: string | null = null;
  let startMs = Infinity, endMs = -Infinity, msgs = 0;
  let total: Record<string, number> | null = null;   // cumulative; keep the last seen
  const tools: Record<string, number> = {};
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
    if (rec.type === "response_item" && payload?.type === "function_call" && typeof payload.name === "string") {
      tools[payload.name] = (tools[payload.name] ?? 0) + 1;
    }
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
  return { agent: "codex", sessionId, project: projectLabel(cwd, normalize), cwd, model, gitBranch: null, startMs, endMs, msgs, tokensIn, tokensOut, tokensCache: cached, ...usageFields(tools, {}, {}) };
}

// Files the default-path scan reads, across every enumerable source. This is the
// basis for the cache-validity token: a new or updated session anywhere (count or
// newest mtime changes) yields a new token, so the cache stays valid until the
// transcripts actually change — and never expires on an idle machine. Enumeration
// (readdir + stat, no reads) is cheap relative to the full parse it gates.
function sessionScanToken(): string {
  const files = BUILTIN_SOURCES
    .filter((s) => s.scanSessions && s.watchFiles)
    .flatMap((s) => s.watchFiles!(s.roots({})));
  return transcriptToken(files);
}

let _cache: { token: string; stats: SessionStat[] } | null = null;
/** Cached scan for the request path, keyed by a transcript token (not a timer): a
 *  fresh cache serves instantly and unchanged transcripts never trigger a re-scan,
 *  so the default screen stays warm across idle gaps. `refresh` (?refresh=true) forces
 *  a re-scan. Custom dirs are never cached — only the default path is. The leading
 *  arg is a vestigial timestamp kept for call-site compatibility; the token supersedes it. */
export async function scanSessionsCached(_nowMs?: number, dirs?: { claudeDir?: string; codexDir?: string }, refresh = false): Promise<SessionStat[]> {
  if (dirs) return scanSessions(dirs);                       // custom dirs are never cached
  const token = sessionScanToken();
  if (!refresh && _cache && _cache.token === token) return _cache.stats;
  const stats = await scanSessions();
  _cache = { token, stats };
  return stats;
}
/** Test seam: drop the whole-scan cache (and the underlying per-file parse cache). */
export function clearScanCache(): void { _cache = null; clearParseCache(); }

/** True when the default-path scan cache matches the current transcripts. Lets the
 *  background warmer report hit-vs-warmed without re-scanning. */
export function isSessionScanFresh(): boolean {
  return _cache !== null && _cache.token === sessionScanToken();
}

export async function scanSessions(dirs?: { claudeDir?: string; codexDir?: string }, specs: SourceSpec[] = BUILTIN_SOURCES): Promise<SessionStat[]> {
  // Preserve the legacy per-agent override: dirs.claudeDir feeds baseDir; dirs.codexDir
  // (if given independently) overrides codex's own root instead of deriving from baseDir.
  const env = { baseDir: dirs?.claudeDir, codexDir: dirs?.codexDir };
  const out: SessionStat[] = [];
  for (const spec of specs) {
    if (!spec.scanSessions) continue;
    try { out.push(...(await spec.scanSessions(spec.roots(env)))); } catch { /* a source never breaks the scan */ }
  }
  return out;
}
