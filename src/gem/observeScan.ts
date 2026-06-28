// src/gem/observeScan.ts
//
// Deterministic transcript → SessionStat. Walks the local Claude + Codex session
// stores and normalizes each session into one usage/timing record. Privacy
// boundary: reads usage, timestamps, model, type, cwd/id ONLY — never message
// text (mirrors workflowScan.ts). Total functions: missing dirs / malformed
// lines degrade to empty/skip, never throw.
import { readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { resolveDirs } from "../resolveDir.js";

export interface SessionStat {
  agent: "claude" | "codex";
  sessionId: string;
  project: string | null;   // basename of session cwd, or null
  model: string | null;
  startMs: number;
  endMs: number;
  msgs: number;
  tokensIn: number;         // fresh input (cache excluded)
  tokensOut: number;        // output (+ reasoning for codex)
  tokensCache: number;      // cache read+creation (claude) / cached_input (codex)
}

function* jsonLines(path: string): Generator<Record<string, unknown>> {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return; }
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

export function parseClaudeTranscript(path: string): SessionStat | null {
  let sessionId = "", cwd: string | null = null, model: string | null = null;
  let startMs = Infinity, endMs = -Infinity, msgs = 0, tokensIn = 0, tokensOut = 0, tokensCache = 0;
  for (const rec of jsonLines(path)) {
    const type = rec.type as string | undefined;
    if (typeof rec.sessionId === "string") sessionId = rec.sessionId;
    if (typeof rec.cwd === "string") cwd = rec.cwd;
    const ts = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
    if (!Number.isNaN(ts)) { startMs = Math.min(startMs, ts); endMs = Math.max(endMs, ts); }
    if (type === "user" || type === "assistant") msgs++;
    const msg = rec.message as Record<string, unknown> | undefined;
    if (msg && typeof msg.model === "string") model = msg.model;
    const u = msg?.usage as Record<string, number> | undefined;
    if (u) {
      tokensIn += u.input_tokens ?? 0;
      tokensOut += u.output_tokens ?? 0;
      tokensCache += (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    }
  }
  if (!sessionId || endMs < startMs) return null;
  return { agent: "claude", sessionId, project: cwd ? basename(cwd) : null, model, startMs, endMs, msgs, tokensIn, tokensOut, tokensCache };
}

export function parseCodexTranscript(path: string): SessionStat | null {
  let sessionId = "", cwd: string | null = null, model: string | null = null;
  let startMs = Infinity, endMs = -Infinity, msgs = 0;
  let total: Record<string, number> | null = null;   // cumulative; keep the last seen
  for (const rec of jsonLines(path)) {
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
  return { agent: "codex", sessionId, project: cwd ? basename(cwd) : null, model, startMs, endMs, msgs, tokensIn, tokensOut, tokensCache: cached };
}

export function scanSessions(dirs?: { claudeDir?: string; codexDir?: string }): SessionStat[] {
  const resolved = resolveDirs();
  const claudeDir = dirs?.claudeDir ?? resolved.claudeDir;
  const codexDir = dirs?.codexDir ?? resolved.codexDir;
  const out: SessionStat[] = [];
  for (const f of listFiles(join(claudeDir, "projects"), ".jsonl")) {
    const s = parseClaudeTranscript(f); if (s) out.push(s);
  }
  for (const f of listFiles(join(codexDir, "sessions"), ".jsonl")) {
    if (!basename(f).startsWith("rollout-")) continue;   // skip history.jsonl etc.
    const s = parseCodexTranscript(f); if (s) out.push(s);
  }
  return out;
}
