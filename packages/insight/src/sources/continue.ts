// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Continue.dev ingestion. Sessions are plain JSON: an index (sessions.json) of metadata + one
// <sessionId>.json per session carrying history + an optional `usage` token block + chatModelTitle.
// Continue records NO per-message timestamp, so start time comes from the index `dateCreated`
// (ms-epoch) and end time from the session file mtime. Metadata only — never reads message
// `content` and never the session `title` (a content-derived summary). Total: malformed → null/skip.
import { readFile, readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import type { SessionStat } from "../observeAggregate.js";

interface CUsage { promptTokens?: number; completionTokens?: number; promptTokensDetails?: { cachedTokens?: number } }
interface CSession { sessionId?: string; workspaceDirectory?: string; chatModelTitle?: string | null;
  history?: { message?: { role?: string; usage?: CUsage } }[]; usage?: CUsage }

function tokensFrom(u: CUsage | undefined): { in: number; out: number; cache: number } {
  const cache = u?.promptTokensDetails?.cachedTokens ?? 0;
  return { in: Math.max(0, (u?.promptTokens ?? 0) - cache), out: u?.completionTokens ?? 0, cache };
}

export function parseContinueSession(
  sessionJson: string,
  meta: { dateCreated?: string; messageCount?: number; mtimeMs: number },
): SessionStat | null {
  let s: CSession;
  try { s = JSON.parse(sessionJson) as CSession; } catch { return null; }
  if (!s || typeof s !== "object") return null;
  const history = Array.isArray(s.history) ? s.history : [];
  const msgs = meta.messageCount ?? history.filter((h) => h.message?.role === "user" || h.message?.role === "assistant").length;
  if (msgs === 0 && !s.sessionId) return null;

  let tIn = 0, tOut = 0, tCache = 0;
  if (s.usage) { const t = tokensFrom(s.usage); tIn = t.in; tOut = t.out; tCache = t.cache; }
  else for (const h of history) if (h.message?.role === "assistant" && h.message.usage) { const t = tokensFrom(h.message.usage); tIn += t.in; tOut += t.out; tCache += t.cache; }

  const startMs = meta.dateCreated ? parseInt(meta.dateCreated, 10) : meta.mtimeMs;
  const endMs = Math.max(meta.mtimeMs, startMs);
  return {
    agent: "continue", sessionId: s.sessionId ?? "", project: s.workspaceDirectory ? basename(s.workspaceDirectory) : null,
    model: s.chatModelTitle ?? null, gitBranch: null,
    startMs: Number.isNaN(startMs) ? endMs : startMs, endMs, msgs, tokensIn: tIn, tokensOut: tOut, tokensCache: tCache,
  };
}

export async function scanContinueSessions(sessionsDir: string): Promise<SessionStat[]> {
  let indexRaw: string;
  try { indexRaw = await readFile(join(sessionsDir, "sessions.json"), "utf8"); } catch { return []; }
  let index: { sessionId?: string; dateCreated?: string; messageCount?: number }[];
  try { index = JSON.parse(indexRaw) as typeof index; } catch { return []; }
  if (!Array.isArray(index)) return [];
  const byId = new Map(index.filter((e) => e && typeof e.sessionId === "string").map((e) => [e.sessionId!, e]));

  const out: SessionStat[] = [];
  let files: string[]; try { files = (await readdir(sessionsDir)).filter((f) => f.endsWith(".json") && f !== "sessions.json"); } catch { return out; }
  for (const f of files) {
    const path = join(sessionsDir, f);
    let text: string, mtimeMs: number;
    try { text = await readFile(path, "utf8"); mtimeMs = (await stat(path)).mtimeMs; } catch { continue; }
    const id = basename(f, ".json");
    const e = byId.get(id);
    const stat_ = parseContinueSession(text, { dateCreated: e?.dateCreated, messageCount: e?.messageCount, mtimeMs });
    if (stat_) { if (!stat_.sessionId) stat_.sessionId = id; out.push(stat_); }
  }
  return out;
}
