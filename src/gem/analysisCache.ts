// src/gem/analysisCache.ts
//
// Per-project cache of the (expensive, ~15-20s) workflow analysis. Keyed by the
// project root and a transcript "token" that changes whenever a session is added
// or updated — so the cache stays valid until the project's sessions change, and
// revisiting a project to pick a different candidate is instant. Best-effort and
// persistent (~/.agentgem/analysis-cache.json); failures never throw.
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { agentgemHome } from "../resolveDir.js";

const MAX_ENTRIES = 50;
function cachePath(): string { return join(agentgemHome(), ".agentgem", "analysis-cache.json"); }

// Bump on any change to what an analysis result contains (the token is otherwise
// content-blind). v2 = the payload now carries the `distilled` track, so v1 entries
// (which lack it) must not be served (proposal §8).
const TOKEN_VERSION = "v2";

/** A cheap validity token: version + transcript count + newest mtime. New/updated session → new token. */
export function transcriptToken(paths: string[]): string {
  let maxMs = 0;
  for (const p of paths) { try { const m = statSync(p).mtimeMs; if (m > maxMs) maxMs = m; } catch { /* gone — ignore */ } }
  return `${TOKEN_VERSION}:${paths.length}:${Math.round(maxMs)}`;
}

interface Entry { root: string; token: string; result: unknown; ts: number }
function readAll(): Entry[] {
  try { const j = JSON.parse(readFileSync(cachePath(), "utf8")); return Array.isArray(j) ? j : []; } catch { return []; }
}

/** Cached result for (root, token), or null on miss/stale. */
export function readAnalysisCache(root: string, token: string): unknown | null {
  const e = readAll().find((x) => x.root === root && x.token === token);
  return e ? e.result : null;
}

/** Store (root, token) → result, replacing any prior entry for root. Capped + best-effort. */
export function writeAnalysisCache(root: string, token: string, result: unknown, nowMs: number): void {
  try {
    const all = readAll().filter((x) => x.root !== root);
    all.push({ root, token, result, ts: nowMs });
    all.sort((a, b) => b.ts - a.ts);
    const path = cachePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(all.slice(0, MAX_ENTRIES)), "utf8");
  } catch { /* best-effort */ }
}
