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
  type ProjectLoad,
  type ScorecardDeps,
} from "./gem/scorecard.js";
import { transcriptToken, readAnalysisCache, writeAnalysisCache } from "@agentgem/insight";

// Minimal structural types for the Express req/res we use — avoids a hard
// dependency on @types/express (expressApp's handler is duck-typed).
interface SseReq { query: Record<string, unknown> }
interface SseRes {
  writeHead(status: number, headers: Record<string, string>): void;
  write(chunk: string): void;
  end(): void;
}

export interface ScorecardStreamDeps extends ScorecardDeps {
  readCache(root: string, token: string): unknown | null;
  writeCache(root: string, token: string, result: unknown, nowMs: number): void;
}

const realStreamDeps: ScorecardStreamDeps = {
  ...defaultScorecardDeps,
  readCache: readAnalysisCache,
  writeCache: writeAnalysisCache,
};

// Cache key used for the aggregate scorecard (distinct from per-project keys).
const CACHE_ROOT = "__scorecard__";
const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));

function parseProjects(q: unknown): string[] | undefined {
  if (typeof q !== "string" || !q) return undefined;
  try {
    const v = JSON.parse(q);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : undefined;
  } catch { return undefined; }
}

export async function streamScorecard(req: SseReq, res: SseRes, deps: ScorecardStreamDeps = realStreamDeps): Promise<void> {
  const dir = typeof req.query.dir === "string" ? req.query.dir : undefined;
  const projects = parseProjects(req.query.projects);
  const fresh = req.query.fresh === "1";   // bypass the cache (Re-scan)

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
      const cached = deps.readCache(CACHE_ROOT, token);
      if (cached) { send("done", { scorecard: cached, cached: true }); return; }
    }

    send("start", { total: roots.length });
    const loads: ProjectLoad[] = [];
    let degraded = false;
    for (let i = 0; i < roots.length; i++) {
      await yieldToLoop();   // yield so each progress frame actually flushes
      const loaded = deps.loadProject(roots[i], dir, bucket.get(roots[i]) ?? []);
      if (!loaded) degraded = true;
      else loads.push({ root: roots[i], label: basename(roots[i]), ...loaded });
      const partial = aggregateScorecard(loads, Date.now(), degraded);
      send("progress", {
        done: i + 1,
        total: roots.length,
        label: basename(roots[i]),
        partial: { breadth: partial.breadth, battleTested: partial.battleTested, portable: partial.portable },
      });
    }
    const sc = aggregateScorecard(loads, Date.now(), degraded);
    if (!degraded) deps.writeCache(CACHE_ROOT, token, sc, Date.now());
    send("done", { scorecard: sc, cached: false });
  } catch (err) {
    send("failed", { message: (err as Error)?.message ?? String(err) });
  } finally {
    res.end();
  }
}
