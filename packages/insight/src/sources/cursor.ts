// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Cursor ingestion. Sessions live in a binary SQLite DB (state.vscdb, table cursorDiskKV):
// composerData:<id> rows (session + ordered bubble headers) and bubbleId:<id>:<bid> rows (one
// message each). Cell values are JSON STRINGS (double-decode). The DB is WAL-mode and locked
// while Cursor runs, so we COPY it (+ sidecars) to a temp file and open read-only. Metadata only:
// we read a bubble's type/createdAt/token fields — NEVER its text/thinking/codeBlocks/toolFormerData.
// Total: a missing/locked/corrupt DB or malformed blob degrades to [] / skip, never throws.
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SessionStat } from "../observeAggregate.js";

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const parse = (s: unknown): Record<string, unknown> | null => {
  if (typeof s !== "string") return (s && typeof s === "object") ? s as Record<string, unknown> : null;
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return null; }
};

interface KV { key: string; value: string }

/** Pure core: fold cursorDiskKV rows into one SessionStat per composer. Exported for testing. */
export function aggregateComposers(rows: KV[]): SessionStat[] {
  // group bubbles by composerId (from the key bubbleId:<composerId>:<bubbleId>)
  const composers = new Map<string, Record<string, unknown>>();
  const bubblesByComposer = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) {
    if (r.key.startsWith("composerData:")) {
      const id = r.key.slice("composerData:".length);
      const o = parse(r.value); if (o) composers.set(id, o);
    } else if (r.key.startsWith("bubbleId:")) {
      const rest = r.key.slice("bubbleId:".length);
      const composerId = rest.split(":")[0];
      const o = parse(r.value); if (!o) continue;
      (bubblesByComposer.get(composerId) ?? bubblesByComposer.set(composerId, []).get(composerId)!).push(o);
    }
  }
  const out: SessionStat[] = [];
  for (const [id, composer] of composers) {
    const bubbles = bubblesByComposer.get(id) ?? [];
    const headers = composer.fullConversationHeadersOnly;
    const msgs = Array.isArray(headers) ? headers.length : bubbles.length;
    if (msgs === 0) continue;
    let startMs = Infinity, endMs = -Infinity, tIn = 0, tOut = 0; let model: string | null = null;
    for (const b of bubbles) {
      const ts = n(b.createdAt);
      if (ts > 0) { startMs = Math.min(startMs, ts); endMs = Math.max(endMs, ts); }
      tIn += n(b.inputTokens); tOut += n(b.outputTokens);
      if (!model && typeof b.model === "string") model = b.model;   // best-effort
    }
    if (typeof composer.lastUsedModel === "string" && !model) model = composer.lastUsedModel as string;
    if (endMs < startMs) { startMs = 0; endMs = 0; }
    out.push({ agent: "cursor", sessionId: id, project: null, model, gitBranch: null, startMs, endMs, msgs, tokensIn: tIn, tokensOut: tOut, tokensCache: 0 });
  }
  return out;
}

export async function scanCursorSessions(dbPath: string): Promise<SessionStat[]> {
  // copy-before-read: never open Cursor's live (WAL-locked) DB in place.
  let tmp: string | null = null;
  try {
    tmp = await mkdtemp(join(tmpdir(), "cursor-db-"));
    const copyPath = join(tmp, "state.vscdb");
    await copyFile(dbPath, copyPath);                         // throws if dbPath absent -> caught below
    for (const ext of ["-wal", "-shm"]) { try { await copyFile(dbPath + ext, copyPath + ext); } catch { /* sidecar may not exist */ } }
    let rows: KV[] = [];
    try {
      const db = new DatabaseSync(copyPath, { readOnly: true });
      try {
        // cursorDiskKV may not exist on very old/legacy DBs -> guard.
        const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cursorDiskKV'").get();
        if (has) rows = db.prepare("SELECT key, CAST(value AS TEXT) AS value FROM cursorDiskKV WHERE key LIKE 'composerData:%' OR key LIKE 'bubbleId:%'").all() as unknown as KV[];
      } finally { db.close(); }
    } catch { return []; }
    return aggregateComposers(rows);
  } catch { return []; }
  finally { if (tmp) { try { await rm(tmp, { recursive: true, force: true }); } catch { /* best effort */ } } }
}
