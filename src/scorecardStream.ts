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
import { transcriptToken, writeAnalysisCache, readAnalysisCacheEntry } from "@agentgem/insight";
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
  writeCache(root: string, token: string, result: unknown, nowMs: number): void;
}

const realStreamDeps: ScorecardStreamDeps = {
  ...defaultScorecardDeps,
  readCacheEntry: readAnalysisCacheEntry,
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
    const roots = selectScorecardRoots(dir, projects, deps);
    const bucket = deps.bucketTranscripts(dir);
    const paths = scorecardTranscriptPaths(roots, bucket);
    const token = transcriptToken(paths);

    // Cache hit (unless Re-scan): return the prior result instantly so the user
    // can revisit the scorecard without re-scanning every project.
    if (!fresh) {
      const entry = deps.readCacheEntry(SCORECARD_CACHE_ROOT, token);
      if (entry) { send("done", { scorecard: entry.result, cached: true, updatedAt: entry.ts }); return; }
    }

    send("start", { total: roots.length });
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
