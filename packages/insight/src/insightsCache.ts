// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/insightsCache.ts
//
// Per-project cache of the (expensive — two agent passes) insights report. A
// SEPARATE file from analysisCache (insights-cache.json vs analysis-cache.json)
// so the two never evict each other for the same root, and so the insights
// payload can version independently. Keyed by root + a transcript token that
// changes when sessions change. Best-effort; never throws.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { agentgemHome, writeJsonAtomic } from "@agentgem/model";

const MAX_ENTRIES = 50;
function cachePath(): string { return join(agentgemHome(), ".agentgem", "insights-cache.json"); }

// Bump when the report shape changes so stale-shape entries aren't served.
// iv1 = { report (totals, outcomes_summary, narrative, friction, publish_candidates), facets }.
// iv2 = report also carries by_model (Ring 0 cross-model breakdown) — iv1 entries
// lack it and would crash the panel, so they must not be served.
const TOKEN_VERSION = "iv2";

/** version + transcript count + newest mtime — a new/updated session yields a new token. */
export function insightsToken(paths: string[]): string {
  let maxMs = 0;
  for (const p of paths) { try { const m = statSync(p).mtimeMs; if (m > maxMs) maxMs = m; } catch { /* gone — ignore */ } }
  return `${TOKEN_VERSION}:${paths.length}:${Math.round(maxMs)}`;
}

interface Entry { root: string; token: string; result: unknown; ts: number }
function readAll(): Entry[] {
  try { const j = JSON.parse(readFileSync(cachePath(), "utf8")); return Array.isArray(j) ? j : []; } catch { return []; }
}

/** Cached report for (root, token), or null on miss/stale. */
export function readInsightsCache(root: string, token: string): unknown | null {
  const e = readAll().find((x) => x.root === root && x.token === token);
  return e ? e.result : null;
}

/** Cached entry (result + write timestamp) for (root, token), or null on miss/stale. */
export function readInsightsCacheEntry(root: string, token: string): { result: unknown; ts: number } | null {
  const e = readAll().find((x) => x.root === root && x.token === token);
  return e ? { result: e.result, ts: e.ts } : null;
}

/** Store (root, token) → result, replacing any prior entry for root. Capped + best-effort. */
export function writeInsightsCache(root: string, token: string, result: unknown, nowMs: number): void {
  try {
    const all = readAll().filter((x) => x.root !== root);
    all.push({ root, token, result, ts: nowMs });
    all.sort((a, b) => b.ts - a.ts);
    writeJsonAtomic(cachePath(), all.slice(0, MAX_ENTRIES));
  } catch { /* best-effort */ }
}
