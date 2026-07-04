// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/cachedCompute.ts
//
// The cache-aware compute skeleton shared by the headless *Core modules
// (insightsCore, distillCore, rubricCore): token → cache-read → compute →
// cache-write UNLESS the payload is degraded. Extracted at the third copy (rule
// of three). One place now owns the never-cache-a-degraded-result invariant.
//
// Scorecard is intentionally NOT a client: its cache lives in scorecardStream
// (an aggregate keyed by SCORECARD_CACHE_ROOT), not a per-root computeX core, so
// it does not fit this shape and forcing it in would be over-engineering.

export interface CacheHit<P> { result: P; ts: number }
export interface CachedResult<P> { payload: P; cached: boolean; updatedAt: number | null }

export interface CachedComputeArgs<P> {
  token: string;
  read: (token: string) => CacheHit<P> | null;
  write: (token: string, payload: P, ts: number) => void;
  compute: () => Promise<P>;
  degraded: (payload: P) => boolean;    // a degraded payload is returned but never cached
  force?: boolean;                       // bypass the read (Re-scan)
  now?: () => number;                    // injectable clock (default Date.now)
  // `cacheOnly` callers (e.g. the dream harvest) want a cache hit or nothing —
  // on a miss they get `onCacheOnlyMiss()` without spending the compute.
  cacheOnly?: boolean;
  onCacheOnlyMiss?: () => P;
}

/**
 * Read-through cache around an async compute. Returns `{ cached: true }` with the
 * stored timestamp on a hit; otherwise computes, writes only when not degraded,
 * and returns `{ cached: false, updatedAt }` (null when degraded or cacheOnly-miss).
 */
export async function computeCached<P>(args: CachedComputeArgs<P>): Promise<CachedResult<P>> {
  const now = args.now ?? Date.now;
  if (!args.force) {
    const hit = args.read(args.token);
    if (hit) return { payload: hit.result, cached: true, updatedAt: hit.ts };
  }
  if (args.cacheOnly) {
    if (!args.onCacheOnlyMiss) throw new Error("computeCached: cacheOnly requires onCacheOnlyMiss");
    return { payload: args.onCacheOnlyMiss(), cached: false, updatedAt: null };
  }
  const payload = await args.compute();
  let updatedAt: number | null = null;
  if (!args.degraded(payload)) { const ts = now(); args.write(args.token, payload, ts); updatedAt = ts; }
  return { payload, cached: false, updatedAt };
}
