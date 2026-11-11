// Copyright (c) 2026 Zhaohui Feng
// SPDX-License-Identifier: MIT
// packages/insight/src/dashboardCache.ts
//
// Per-session cache of the (expensive, agent-generated) session dashboard HTML.
// Keyed by sessionId and a token derived from the transcript's mtime — the
// dashboard stays valid until the session's transcript changes, so reopening a
// finished session is instant. Same shape as analysisCache (root → sessionId).
// Best-effort and persistent (~/.agentgem/session-dashboard-cache.json).
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { agentgemHome, writeJsonAtomic, HOUSE_TOKENS, themeAdapter } from "@agentgem/model";
import { SHARED_CHECK_IDS, type Finding } from "@ninemind/miniapp-gate";
import { REPORT_BUILDER_BRIEF } from "./reportBrief.js";
import { REPORT_CHECK_IDS } from "./reportChecks.js";

const MAX_ENTRIES = 50;
function cachePath(): string { return join(agentgemHome(), ".agentgem", "session-dashboard-cache.json"); }

// Structural version. Bump only when the ENTRY shape changes; the renderer fingerprint below handles
// contract changes on its own.
const TOKEN_VERSION = "dv1";

// WHAT PRODUCES THE OUTPUT, hashed.
//
// The mtime component answers "did the input change?" It never answered "did the thing that PRODUCES
// the output change?", so any change to what a render emits kept serving pre-change cached HTML —
// and a finished session's transcript never changes again, so those entries never aged out. The old
// comment here asked a human to remember to bump a constant; nobody did, and the identical hole was
// already recorded once against rubricToken.
//
// Hashing the authoring brief, the house style, and the check ids means a renderer change invalidates
// itself. Stable within a build (same inputs → same hash), so it costs nothing on the hot path.
let fingerprint: string | null = null;
export function rendererFingerprint(): string {
  if (fingerprint) return fingerprint;
  const contract = [
    REPORT_BUILDER_BRIEF,
    HOUSE_TOKENS,
    themeAdapter("document"),
    SHARED_CHECK_IDS.join(","),
    REPORT_CHECK_IDS.join(","),
    // NUL separator, written as the ESCAPE and never as a literal byte. A NUL is the right joiner —
    // no brief or check id can contain one, so two different contracts cannot collide into the same
    // hash the way a space or comma allows. But a literal NUL in the source makes the whole file
    // read as binary: plain `grep` then matches nothing and says nothing, which already cost one
    // false "this commit did not land" during a merge verification. Same byte at runtime, greppable
    // source. Guarded by dashboardCache.source.test.ts.
  ].join("\0");
  fingerprint = createHash("sha256").update(contract).digest("hex").slice(0, 8);
  return fingerprint;
}

/** Validity token: structural version + renderer fingerprint + transcript mtime. Either the input or
 *  the producer changing yields a new token. */
export function dashboardToken(transcriptPath: string): string {
  let ms = 0;
  try { ms = statSync(transcriptPath).mtimeMs; } catch { /* gone — token still forms */ }
  return `${TOKEN_VERSION}:${rendererFingerprint()}:${Math.round(ms)}`;
}

// A session holds one cached artifact per kind: the compact `summary` dashboard
// and the long-form `report` readout. Entries written before kinds existed have
// no `kind` field and read back as "summary".
export type DashboardKind = "summary" | "report";
// `findings` is optional on the WIRE because entries written before it existed have none. Readers
// normalize it to [] so a consumer never has to distinguish "old entry" from "no findings".
interface Entry { sessionId: string; kind?: DashboardKind; token: string; html: string; ts: number; findings?: Finding[] }
function readAll(): Entry[] {
  try { const j = JSON.parse(readFileSync(cachePath(), "utf8")); return Array.isArray(j) ? j : []; } catch { return []; }
}
const kindOf = (e: Entry): DashboardKind => e.kind ?? "summary";

/** Cached entry (html + write timestamp) for (sessionId, kind, token), or null on miss/stale. */
export function readDashboardCacheEntry(sessionId: string, token: string, kind: DashboardKind = "summary"): { html: string; ts: number; findings: Finding[] } | null {
  const e = readAll().find((x) => x.sessionId === sessionId && kindOf(x) === kind && x.token === token);
  return e ? { html: e.html, ts: e.ts, findings: e.findings ?? [] } : null;
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
export function writeDashboardCache(sessionId: string, token: string, html: string, nowMs: number, kind: DashboardKind = "summary", findings: Finding[] = []): void {
  try {
    const all = readAll().filter((x) => !(x.sessionId === sessionId && kindOf(x) === kind));
    all.push({ sessionId, kind, token, html, ts: nowMs, findings });
    all.sort((a, b) => b.ts - a.ts);
    writeJsonAtomic(cachePath(), all.slice(0, MAX_ENTRIES));
  } catch { /* best-effort */ }
}
