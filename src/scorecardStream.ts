// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/scorecardStream.ts
//
// SSE endpoint for the goldmine scorecard scan. Mirrors workflowStream.ts: the
// decorator framework returns one JSON body, so streaming progress is a raw
// Express handler. The scan is sync per project, so we yield between projects
// (await setImmediate) to flush each progress frame.
import { basename } from "node:path";
import {
  selectScorecardRoots,
  aggregateScorecard,
  scorecardTranscriptPaths,
  defaultScorecardDeps,
  loadProjectCached,
  type ProjectLoad,
  type ScorecardDeps,
} from "./gem/scorecard.js";
import { transcriptToken, writeAnalysisCache, readAnalysisCacheEntry, readAnalysisCacheLatest } from "@agentgem/insight";
import { createLogger } from "@agentgem/base";

const log = createLogger("scorecard");

// Minimal structural types for the Express req/res we use — avoids a hard
// dependency on @types/express (expressApp's handler is duck-typed).
interface SseReq { query: Record<string, unknown> }
interface SseRes {
  writeHead(status: number, headers: Record<string, string>): void;
  write(chunk: string): void;
  end(): void;
}

export interface ScorecardStreamDeps extends ScorecardDeps {
  readCacheEntry(root: string, token: string): { result: unknown; ts: number } | null;
  readLatestCache(root: string): { result: unknown; ts: number } | null;
  writeCache(root: string, token: string, result: unknown, nowMs: number): void;
}

const realStreamDeps: ScorecardStreamDeps = {
  ...defaultScorecardDeps,
  readCacheEntry: readAnalysisCacheEntry,
  readLatestCache: readAnalysisCacheLatest,
  writeCache: writeAnalysisCache,
};

// Cache key used for the aggregate scorecard (distinct from per-project keys).
export const SCORECARD_CACHE_ROOT = "__scorecard__";
const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));

function parseProjects(q: unknown): string[] | undefined {
  if (typeof q !== "string" || !q) return undefined;
  try {
    const v = JSON.parse(q);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : undefined;
  } catch (err) { log.debug("parseProjects failed: %s", (err as Error)?.message ?? err); return undefined; }
}

export async function streamScorecard(req: SseReq, res: SseRes, deps: ScorecardStreamDeps = realStreamDeps): Promise<void> {
  const dir = typeof req.query.dir === "string" ? req.query.dir : undefined;
  const projects = parseProjects(req.query.projects);
  const fresh = req.query.refresh === "true";   // ?refresh=true bypasses the cache (Re-scan)

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // disable proxy buffering so events flush immediately
  });
  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    // Stale-while-revalidate: paint the last-good scorecard FIRST — before any corpus read (root
    // discovery, bucketing) — since it only needs the small on-disk cache. Token-INDEPENDENT, so it
    // survives the token churn a live-updating corpus causes. The client shows it instantly with an
    // "updating…" pill and swaps to the fresh `done` below. On a cold machine (no cache) this is a
    // no-op and the panel shows the normal scanning progress.
    if (!fresh) {
      const latest = deps.readLatestCache(SCORECARD_CACHE_ROOT);
      // Yield after the write so the socket actually flushes the frame BEFORE the seconds-long,
      // synchronous root-discovery/bucket reads below pin the event loop. Without this the `stale`
      // bytes sit in the send buffer until the loop next frees (~1s later), defeating the instant
      // paint — writing a frame doesn't transmit it while the same tick keeps running.
      if (latest) { send("stale", { scorecard: latest.result, updatedAt: latest.ts }); await yieldToLoop(); }
    }

    const roots = selectScorecardRoots(dir, projects, deps);

    // Emit `start` BEFORE bucketing the transcripts: the bucket read (and, on a hit, the cache
    // lookup that depends on its token) can take seconds on a large corpus, and doing it before the
    // first event left the panel on a blank loading skeleton the whole time. A cache hit still
    // short-circuits to `done` right after. Yield so this frame flushes before the bucket read pins
    // the loop (same reason as the `stale` yield above) — it's what shows "scanning" on a cold machine.
    send("start", { total: roots.length });
    await yieldToLoop();

    const bucket = deps.bucketTranscripts(dir);
    const paths = scorecardTranscriptPaths(roots, bucket);
    const token = transcriptToken(paths);

    // Exact cache hit (unless Re-scan): the last-good result is current for this corpus, so finalize
    // without re-scanning. (If we just sent `stale` with the same content, this `done` just clears
    // the client's updating state.)
    if (!fresh) {
      const entry = deps.readCacheEntry(SCORECARD_CACHE_ROOT, token);
      if (entry) { send("done", { scorecard: entry.result, cached: true, updatedAt: entry.ts }); return; }
    }
    const loads: ProjectLoad[] = [];
    let degraded = false;
    for (let i = 0; i < roots.length; i++) {
      await yieldToLoop();   // yield so each progress frame actually flushes
      // Per-project cache-first (via defaultScorecardDeps): only the changed project(s)
      // re-scan, so a warm re-stream flushes near-instantly instead of re-scanning all.
      const load = loadProjectCached(deps, roots[i], dir, bucket.get(roots[i]) ?? [], Date.now());
      if (!load) degraded = true;
      else loads.push(load);
      const partial = aggregateScorecard(loads, Date.now(), degraded);
      send("progress", {
        done: i + 1,
        total: roots.length,
        label: basename(roots[i]),
        partial: { breadth: partial.breadth, battleTested: partial.battleTested, portable: partial.portable },
      });
    }
    const nowMs = Date.now();
    const sc = aggregateScorecard(loads, nowMs, degraded);
    if (!degraded) deps.writeCache(SCORECARD_CACHE_ROOT, token, sc, nowMs);
    send("done", { scorecard: sc, cached: false, updatedAt: nowMs });
  } catch (err) {
    send("failed", { message: (err as Error)?.message ?? String(err) });
  } finally {
    res.end();
  }
}
