// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Gemini CLI ingestion. Session files are append-only JSONL that MIX a header line, message
// lines, and mutation lines ($rewindTo / $set). To count messages + sum tokens correctly we
// replay the CLI's own fold: an insertion-ordered Map<id,msg>; a re-set id overwrites in place;
// $rewindTo deletes from the id inclusive; $set.messages is a checkpoint replace. Metadata only —
// never reads `content`. Total: malformed lines are skipped, a malformed file yields null.
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { SessionStat } from "../observeAggregate.js";

interface GemTokens { input?: number; output?: number; cached?: number; thoughts?: number; tool?: number; total?: number }
interface GemMsg { id: string; timestamp?: string; type?: string; model?: string; tokens?: GemTokens }

function* lines(text: string): Generator<Record<string, unknown>> {
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line) as Record<string, unknown>; } catch { /* skip malformed */ }
  }
}

export function parseGeminiSession(jsonl: string, fallbackSessionId: string, project: string | null): SessionStat | null {
  const map = new Map<string, GemMsg>();       // insertion-ordered survivors
  let sessionId = "", model: string | null = null;
  for (const rec of lines(jsonl)) {
    if (typeof rec.$rewindTo === "string") {    // drop the id AND everything after it
      const target = rec.$rewindTo;
      if (!map.has(target)) { map.clear(); continue; }
      let seen = false;
      for (const id of [...map.keys()]) { if (id === target) seen = true; if (seen) map.delete(id); }
      continue;
    }
    if (rec.$set && typeof rec.$set === "object") {    // metadata; a messages[] payload is a checkpoint replace
      const set = rec.$set as Record<string, unknown>;
      if (Array.isArray(set.messages)) { map.clear(); for (const m of set.messages as GemMsg[]) if (m && typeof m.id === "string") map.set(m.id, m); }
      continue;
    }
    if (typeof rec.sessionId === "string" && typeof rec.projectHash === "string") { sessionId = rec.sessionId; continue; } // header
    if (typeof rec.id === "string") {                  // message record
      const m = rec as unknown as GemMsg;
      map.set(m.id, m);
    }
  }
  const msgsArr = [...map.values()].filter((m) => m.type === "user" || m.type === "gemini");
  if (msgsArr.length === 0) return null;
  let startMs = Infinity, endMs = -Infinity, tokensIn = 0, tokensOut = 0, tokensCache = 0;
  for (const m of msgsArr) {
    if (m.type === "gemini" && typeof m.model === "string") model = m.model;
    const ts = m.timestamp ? Date.parse(m.timestamp) : NaN;
    if (!Number.isNaN(ts)) { startMs = Math.min(startMs, ts); endMs = Math.max(endMs, ts); }
    if (m.type === "gemini" && m.tokens) {
      const t = m.tokens;
      tokensIn += Math.max(0, (t.input ?? 0) - (t.cached ?? 0));
      tokensOut += (t.output ?? 0) + (t.thoughts ?? 0);
      tokensCache += t.cached ?? 0;
    }
  }
  if (endMs < startMs) return null;
  return { agent: "gemini", sessionId: sessionId || fallbackSessionId, project, model, gitBranch: null, startMs, endMs, msgs: msgsArr.length, tokensIn, tokensOut, tokensCache };
}

// Derive the <slug> project from a `~/.gemini/tmp/<slug>/chats/...` path.
function slugOf(path: string): string | null {
  const m = path.match(/[/\\]tmp[/\\]([^/\\]+)[/\\]chats[/\\]/);
  return m ? m[1] : null;
}

export async function scanGeminiSessions(files: string[]): Promise<SessionStat[]> {
  const out: SessionStat[] = [];
  for (const f of files) {
    let text: string; try { text = await readFile(f, "utf8"); } catch { continue; }
    const fallback = basename(f).replace(/^session-/, "").replace(/\.jsonl$/, "");
    const s = parseGeminiSession(text, fallback, slugOf(f)); if (s) out.push(s);
  }
  return out;
}
