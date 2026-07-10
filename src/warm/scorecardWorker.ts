// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/warm/scorecardWorker.ts
//
// The scorecard warm body, off the server's event loop. Both halves of it block:
// bucketTranscripts (~7s) reads every transcript to bucket by cwd, and
// collectScorecard (~6s) scans the selected roots — and bucketTranscripts runs
// BEFORE the cache-hit check, so even a cached pass used to stall the loop. The
// whole body therefore moves, not just the compute; the parent only needs the
// "warmed" | "hit" verdict back, since the result itself lands in the on-disk
// analysis cache.
//
// Safe to run on a worker thread: this path is pure fs + JSON with a disk-backed
// cache and touches no node:sqlite handle (unlike `usage`, whose sharedIndex() is a
// process-wide DatabaseSync shared with the endpoint, and `observe`, whose cache is
// main-thread heap state).
import { parentPort, workerData } from "node:worker_threads";
import { transcriptToken, readAnalysisCache, writeAnalysisCache } from "@agentgem/insight";
import { collectScorecard, selectScorecardRoots, scorecardTranscriptPaths, defaultScorecardDeps } from "../gem/scorecard.js";
import { SCORECARD_CACHE_ROOT } from "../scorecardStream.js";

export interface ScorecardWarmInput { dir?: string; force?: boolean; nowMs: number }

/** The warm body. Exported so the parent can run it inline when a worker is unavailable. */
export function warmScorecardSync({ dir, force, nowMs }: ScorecardWarmInput): "warmed" | "hit" {
  const bucket = defaultScorecardDeps.bucketTranscripts(dir);
  const roots = selectScorecardRoots(dir, undefined, defaultScorecardDeps);
  const token = transcriptToken(scorecardTranscriptPaths(roots, bucket));
  if (!force && readAnalysisCache(SCORECARD_CACHE_ROOT, token)) return "hit";
  const sc = collectScorecard(dir, undefined, nowMs, { bucket });
  if (!sc.degraded) writeAnalysisCache(SCORECARD_CACHE_ROOT, token, sc, nowMs);
  return "warmed";
}

// Only run as a worker entry: importing this module (the inline fallback, tests)
// must not execute the scan. `parentPort` is null on the main thread.
if (parentPort) {
  parentPort.postMessage(warmScorecardSync(workerData as ScorecardWarmInput));
}
