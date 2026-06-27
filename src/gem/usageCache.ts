// src/gem/usageCache.ts
//
// Single-entry persistent cache for the (expensive: reads every transcript)
// global usage scan. Keyed by a transcript token that changes whenever any
// session is added/updated, so it self-refreshes. Best-effort: failures never throw.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { agentgemHome } from "../resolveDir.js";

function cachePath(): string { return join(agentgemHome(), ".agentgem", "global-usage-cache.json"); }

export function readGlobalUsageCache(token: string): { artifacts: unknown[] } | null {
  try {
    const j = JSON.parse(readFileSync(cachePath(), "utf8")) as { token?: string; result?: { artifacts: unknown[] } };
    return j && j.token === token && j.result ? j.result : null;
  } catch { return null; }
}

export function writeGlobalUsageCache(token: string, result: { artifacts: unknown[] }, claudeDir?: string): void {
  try {
    const path = cachePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ token, result, claudeDir }), "utf8");
  } catch { /* best-effort */ }
}

/** The stored result regardless of token (for stale-while-revalidate). null if no cache file.
 *  If claudeDir is provided, returns null when the cached entry is for a different claudeDir. */
export function readGlobalUsageCacheStale(claudeDir?: string): { artifacts: unknown[] } | null {
  try {
    const j = JSON.parse(readFileSync(cachePath(), "utf8")) as { claudeDir?: string; result?: { artifacts: unknown[] } };
    if (!j || !j.result) return null;
    if (claudeDir !== undefined && j.claudeDir !== claudeDir) return null;
    return j.result;
  } catch { return null; }
}
