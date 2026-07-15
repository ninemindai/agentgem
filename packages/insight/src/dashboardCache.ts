// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/dashboardCache.ts
//
// Per-session cache of the (expensive, agent-generated) session dashboard HTML.
// Keyed by sessionId and a token derived from the transcript's mtime — the
// dashboard stays valid until the session's transcript changes, so reopening a
// finished session is instant. Same shape as analysisCache (root → sessionId).
// Best-effort and persistent (~/.agentgem/session-dashboard-cache.json).
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { agentgemHome, writeJsonAtomic } from "@agentgem/model";

const MAX_ENTRIES = 50;
function cachePath(): string { return join(agentgemHome(), ".agentgem", "session-dashboard-cache.json"); }

// Bump on any change to the dashboard contract (prompt/visual rules) — the token
// is otherwise content-blind and stale entries would keep serving the old look.
const TOKEN_VERSION = "dv1";

/** A cheap validity token: version + transcript mtime. Transcript grew → new token. */
export function dashboardToken(transcriptPath: string): string {
  let ms = 0;
  try { ms = statSync(transcriptPath).mtimeMs; } catch { /* gone — token still forms */ }
  return `${TOKEN_VERSION}:${Math.round(ms)}`;
}

// A session holds one cached artifact per kind: the compact `summary` dashboard
// and the long-form `report` readout. Entries written before kinds existed have
// no `kind` field and read back as "summary".
export type DashboardKind = "summary" | "report";
interface Entry { sessionId: string; kind?: DashboardKind; token: string; html: string; ts: number }
function readAll(): Entry[] {
  try { const j = JSON.parse(readFileSync(cachePath(), "utf8")); return Array.isArray(j) ? j : []; } catch { return []; }
}
const kindOf = (e: Entry): DashboardKind => e.kind ?? "summary";

/** Cached entry (html + write timestamp) for (sessionId, kind, token), or null on miss/stale. */
export function readDashboardCacheEntry(sessionId: string, token: string, kind: DashboardKind = "summary"): { html: string; ts: number } | null {
  const e = readAll().find((x) => x.sessionId === sessionId && kindOf(x) === kind && x.token === token);
  return e ? { html: e.html, ts: e.ts } : null;
}

/** Latest cached entry for (sessionId, kind) IGNORING the token — used to serve a
 *  stale copy instantly when the transcript changed, instead of silently re-running
 *  the expensive agent render. Callers mark the result stale and let the user decide. */
export function readDashboardCacheLatest(sessionId: string, kind: DashboardKind = "summary"): { html: string; ts: number } | null {
  const e = readAll().find((x) => x.sessionId === sessionId && kindOf(x) === kind);
  return e ? { html: e.html, ts: e.ts } : null;
}

/** Store (sessionId, kind, token) → html, replacing any prior entry for that
 *  session+kind. Capped + best-effort. */
export function writeDashboardCache(sessionId: string, token: string, html: string, nowMs: number, kind: DashboardKind = "summary"): void {
  try {
    const all = readAll().filter((x) => !(x.sessionId === sessionId && kindOf(x) === kind));
    all.push({ sessionId, kind, token, html, ts: nowMs });
    all.sort((a, b) => b.ts - a.ts);
    writeJsonAtomic(cachePath(), all.slice(0, MAX_ENTRIES));
  } catch { /* best-effort */ }
}
