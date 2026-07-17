// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/scorecard.stream.controller.ts
//
// The goldmine scorecard SSE scan, on the AgentBack `streamOf:` dispatch (was a
// raw handler — scorecardStream.ts). Tracking-free (no ReportRegistry, no
// foreground guard). Stale-while-revalidate: paint the cached scorecard FIRST
// (`stale`), then `start` → per-project `progress` → `done`. The scan is sync per
// project, so the producer yields to the loop between projects (await setImmediate)
// so each frame flushes before the next sync read pins the loop — same discipline
// the raw handler used, preserved inside the pump producer.
import { basename } from "node:path";
import { z } from "zod";
import { api, get } from "@agentback/openapi";
import {
  selectScorecardRoots,
  aggregateScorecard,
  scorecardTranscriptPaths,
  scorecardCacheToken,
  defaultScorecardDeps,
  loadProjectCached,
  SCORECARD_CACHE_ROOT,
  type ProjectLoad,
  type ScorecardDeps,
} from "./gem/scorecard.js";
import { writeAnalysisCache, readAnalysisCacheEntry, readAnalysisCacheLatest } from "@agentgem/insight";
import { createLogger } from "@agentgem/base";
import { pump } from "./sse/pump.js";
import { ScorecardStreamQuery, ScorecardEvent } from "./scorecard.stream.schema.js";

const log = createLogger("scorecard");

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

// Test seam: swap the scorecard deps (cache + corpus reads) so the route runs
// without a real transcript corpus. Mirrors setInsightsComputeForTests.
let deps: ScorecardStreamDeps = realStreamDeps;
export function setScorecardDepsForTests(d: ScorecardStreamDeps | null): void {
  deps = d ?? realStreamDeps;
}

const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));

function parseProjects(q: unknown): string[] | undefined {
  if (typeof q !== "string" || !q) return undefined;
  try {
    const v = JSON.parse(q);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : undefined;
  } catch (err) { log.debug("parseProjects failed: %s", (err as Error)?.message ?? err); return undefined; }
}

@api({ basePath: "/api" })
export class ScorecardController {
  // GET /api/scorecard/stream?projects=[...]&dir=&refresh=true
  @get("/scorecard/stream", { query: ScorecardStreamQuery, streamOf: ScorecardEvent })
  async *stream(input: {
    query: z.infer<typeof ScorecardStreamQuery>;
  }): AsyncGenerator<z.infer<typeof ScorecardEvent>> {
    const { dir } = input.query;
    const projects = parseProjects(input.query.projects);
    const fresh = input.query.refresh === "true";
    yield* pump<z.infer<typeof ScorecardEvent>>(async (emit) => {
      try {
        // Stale-while-revalidate: paint the last-good scorecard FIRST (token-independent,
        // cheap on-disk read), before the seconds-long corpus reads below. Yield after so
        // the frame flushes before the sync root-discovery pins the loop.
        if (!fresh) {
          const latest = deps.readLatestCache(SCORECARD_CACHE_ROOT);
          if (latest) { emit({ type: "stale", scorecard: latest.result, updatedAt: latest.ts }); await yieldToLoop(); }
        }

        const roots = selectScorecardRoots(dir, projects, deps);
        // Emit `start` BEFORE bucketing (the bucket read can take seconds); yield so it flushes.
        emit({ type: "start", total: roots.length });
        await yieldToLoop();

        const bucket = deps.bucketTranscripts(dir);
        const paths = scorecardTranscriptPaths(roots, bucket);
        const token = scorecardCacheToken(paths);

        // Exact cache hit (unless Re-scan): finalize without re-scanning.
        if (!fresh) {
          const entry = deps.readCacheEntry(SCORECARD_CACHE_ROOT, token);
          if (entry) { emit({ type: "done", scorecard: entry.result, cached: true, updatedAt: entry.ts }); return; }
        }
        const loads: ProjectLoad[] = [];
        let degraded = false;
        for (let i = 0; i < roots.length; i++) {
          await yieldToLoop(); // yield so each progress frame actually flushes
          const load = loadProjectCached(deps, roots[i], dir, bucket.get(roots[i]) ?? [], Date.now());
          if (!load) degraded = true;
          else loads.push(load);
          const partial = aggregateScorecard(loads, Date.now(), degraded);
          emit({
            type: "progress",
            done: i + 1,
            total: roots.length,
            label: basename(roots[i]),
            partial: { breadth: partial.breadth, battleTested: partial.battleTested, portable: partial.portable },
          });
        }
        const nowMs = Date.now();
        const sc = aggregateScorecard(loads, nowMs, degraded);
        if (!degraded) deps.writeCache(SCORECARD_CACHE_ROOT, token, sc, nowMs);
        emit({ type: "done", scorecard: sc, cached: false, updatedAt: nowMs });
      } catch (err) {
        emit({ type: "failed", message: (err as Error)?.message ?? String(err) });
      }
    });
  }
}
