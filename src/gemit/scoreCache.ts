// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gemit/scoreCache.ts
//
// Disk cache for the expensive half of gemit's scan.
//
// collectGemitInputs enumerates cheaply (scanSessionsCached — ~0.07s warm) and then, for
// each of the most recent SAMPLE_CAP sessions, re-reads that session's transcript to derive
// hygiene + process signal. That per-session work is NOT cached anywhere and dominates:
// measured ~21s for a 150-session sample, and ~21s again on the very next call. Worse, the
// existing caches are module-level, so the CLI and the console — separate processes — share
// nothing: `npx agentgem gemit` with the app running paid ~35s and then ~21s more for
// identical work.
//
// The derived signal is a pure function of the session's transcript, so it can be cached on
// disk and reused by every process. The key is the session's own identity plus the counters
// the scan already produced — no extra I/O to compute, and any append to an append-only
// JSONL transcript moves endMs and msgs, which changes the key and forces a recompute. A
// rewrite that preserved every counter would go unnoticed, which does not happen to
// append-only logs; the alternative (stat every transcript) costs an I/O round per session
// to defend against a case the format precludes.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { agentgemHome } from "@agentgem/model";
import type { GemitScoredInput } from "./score.js";

/** Everything collect derives per session — the whole scored row minus `session`, which the
 *  scan supplies for free. */
export type CachedScore = Omit<GemitScoredInput, "session">;

/** Bounded so a long-lived install cannot grow this without limit. A 30-day window scores at
 *  most SAMPLE_CAP sessions, so this holds several windows' worth and still evicts. */
const MAX_ENTRIES = 1000;

const cachePath = (): string => join(agentgemHome(), ".agentgem", "cache", "gemit-scores.json");

/** Identity + content fingerprint. Any append moves endMs/msgs, so the key changes with the
 *  transcript and a stale entry can never be served for a session that has since grown. */
export function scoreCacheKey(s: {
  agent: string; sessionId: string; endMs: number; msgs: number;
  tokensIn: number; tokensOut: number; tokensCache: number;
}): string {
  return [s.agent, s.sessionId, s.endMs, s.msgs, s.tokensIn, s.tokensOut, s.tokensCache].join("|");
}

/** `endMs` is stored alongside the score purely so eviction can keep the newest sessions —
 *  it is the session's own end time, not a cache timestamp. */
export interface CacheEntry { endMs: number; score: CachedScore }

interface CacheFile { v: 1; entries: Record<string, CacheEntry> }

/** Never throws: a missing, unreadable, or malformed cache is simply a cold one.
 *  ASYNC on purpose — this runs inside the console server process, where a multi-MB
 *  synchronous read would block the event loop for every other in-flight request. */
export async function readScoreCache(): Promise<Map<string, CacheEntry>> {
  try {
    const raw = JSON.parse(await readFile(cachePath(), "utf8")) as CacheFile;
    if (raw?.v !== 1 || !raw.entries) return new Map();
    return new Map(Object.entries(raw.entries).filter(([, e]) => e?.score));
  } catch {
    return new Map();
  }
}

/** Atomic (temp + rename) so a reader never observes a half-written file, and so the CLI and
 *  the console writing concurrently can at worst lose one process's additions — a later cache
 *  miss, never corruption. Never throws: failing to persist a cache must not fail a scan. */
export async function writeScoreCache(entries: Map<string, { endMs: number; score: CachedScore }>): Promise<void> {
  try {
    // Evict oldest-first by the session's own end time, so the sessions most likely to appear
    // in the next window are the ones that survive.
    const kept = [...entries.entries()]
      .sort((a, b) => b[1].endMs - a[1].endMs)
      .slice(0, MAX_ENTRIES);
    const file: CacheFile = { v: 1, entries: Object.fromEntries(kept) };
    const path = cachePath();
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(file));
    await rename(tmp, path);
  } catch {
    /* best-effort: a cache that cannot be written just means the next run recomputes */
  }
}
