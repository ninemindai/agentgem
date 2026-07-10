// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/warm/registry.ts
//
// The v1 warmable inventory. Each warm() is cache-aware and returns whether it
// recomputed ("warmed") or found a fresh cache entry ("hit"). Global/aggregate
// warmables ignore the root argument; per-root warmables receive a project root.
import { Worker } from "node:worker_threads";
import { createLogger } from "@agentgem/base";
import { resolveDirs } from "@agentgem/model";
// usage scan + its cache live in @agentgem/capture:
import { computeGlobalUsage, getGlobalUsageIndexed, readGlobalUsageCache, writeGlobalUsageCache } from "@agentgem/capture";
// transcript helpers live in @agentgem/insight:
import { allClaudeTranscripts, transcriptToken, scanSessionsCached, isSessionScanFresh, loadSessionTranscript } from "@agentgem/insight";
// recall index sync:
import { RecallIndex, syncRecallIndex } from "@agentgem/recall";
import { defaultRecallDbPath } from "../goldmine/recall.js";
// the scorecard warm body + its off-thread entry (see runScorecardWarm):
import { warmScorecardSync, type ScorecardWarmInput } from "./scorecardWorker.js";
import { resolveWorkerPath } from "./workerPath.js";
import { computeInsights } from "../insightsCore.js";
import { computeWorkflowAnalysis } from "../workflowCore.js";
import { computeDistill, DISTILL_BACKGROUND_TIMEOUT_MS } from "../distillCore.js";
import { dreamRoot } from "../dream/dreamPass.js";

const log = createLogger("warm");

/**
 * Run the scorecard warm body on a worker thread, keeping its ~13s of synchronous
 * fs+JSON off the server's event loop. Falls back to running inline when the worker
 * entry can't be resolved or the thread dies: warming inline is slow (it stalls
 * requests) but correct, whereas skipping would leave the cache cold and push the
 * same scan into the next user-facing request. The fallback logs, so a packaging
 * regression that hides the worker is visible rather than silently slow.
 */
async function runScorecardWarm(input: ScorecardWarmInput): Promise<WarmStatusValue> {
  const workerPath = resolveWorkerPath(import.meta.url);
  if (!workerPath) {
    log.warn("[warm] scorecard worker not found; warming inline (this blocks the event loop)");
    return warmScorecardSync(input);
  }
  try {
    return await new Promise<WarmStatusValue>((resolve, reject) => {
      const worker = new Worker(workerPath, { workerData: input });
      let settled = false;
      worker.once("message", (v: WarmStatusValue) => { settled = true; resolve(v); void worker.terminate(); });
      worker.once("error", reject);
      worker.once("exit", (code) => { if (!settled) reject(new Error(`scorecard worker exited with code ${code}`)); });
    });
  } catch (e) {
    log.warn("[warm] scorecard worker failed (%s); warming inline", (e as Error)?.message ?? e);
    return warmScorecardSync(input);
  }
}

export type WarmStatusValue = "warmed" | "hit";
export interface Warmable {
  id: "observe" | "usage" | "scorecard" | "insights" | "analyze" | "distill" | "dream" | "recall";
  cost: "cheap" | "llm";
  scope: "global" | "per-root";
  warm(root: string | null, opts: { dir?: string; force?: boolean }): Promise<WarmStatusValue>;
}

export const WARMABLES: Warmable[] = [
  {
    // First in the pass: the Overview (default landing screen) blocks on the session
    // scan behind /api/observe/raw, so warm it before anything else. scanSessionsCached
    // populates its in-memory cache; a fresh (within-TTL) cache short-circuits.
    id: "observe", cost: "cheap", scope: "global",
    async warm(_root, { dir, force }) {
      if (!force && !dir && isSessionScanFresh()) return "hit";
      await scanSessionsCached(undefined, dir ? { claudeDir: dir } : undefined, force);
      return "warmed";
    },
  },
  {
    // /api/usage serves getGlobalUsageIndexed and only reads the JSON cache when that
    // rejects. Warming via computeGlobalUsage therefore reparsed the whole corpus —
    // synchronously, on the server's loop — to fill a cache the healthy path never
    // touches. Warm through the index instead (it reparses only changed transcripts),
    // then mirror the result into the JSON cache so a later index failure is served
    // from disk rather than reparsing the corpus inside a request.
    id: "usage", cost: "cheap", scope: "global",
    async warm(_root, { dir, force }) {
      const dirs = resolveDirs(dir);
      const paths = allClaudeTranscripts(dirs.claudeDir);
      const token = transcriptToken(paths);
      if (!force && readGlobalUsageCache(token)) return "hit";
      // getGlobalUsageIndexed documents the full scan as its fallback when it rejects.
      // Log it: the fallback reparses the whole corpus and blocks the loop for ~15s, so a
      // silent catch turns an index failure into an unexplained stall (it did, once, here).
      const result = await getGlobalUsageIndexed(dirs, paths).catch((e: unknown) => {
        log.warn("[warm] usage index path failed, falling back to full scan: %s", (e as Error)?.message ?? e);
        return computeGlobalUsage(dirs, paths);
      });
      writeGlobalUsageCache(token, result, dirs.claudeDir);
      return "warmed";
    },
  },
  {
    // Both halves of this body block the loop (bucketTranscripts ~7s, collectScorecard
    // ~6s), and bucketTranscripts runs before the cache-hit check — so even a cached
    // pass stalled every HTTP request. Run the whole body on a worker thread; the
    // result lands in the on-disk analysis cache, so only the verdict comes back.
    id: "scorecard", cost: "cheap", scope: "global",
    async warm(_root, { dir, force }) {
      return runScorecardWarm({ dir, force, nowMs: Date.now() });
    },
  },
  {
    id: "recall", cost: "cheap", scope: "global",
    async warm(_root, { dir, force }) {
      const index = new RecallIndex(defaultRecallDbPath());
      try {
        const sessions = await scanSessionsCached(Date.now(), dir ? { claudeDir: dir } : undefined, force);
        const r = await syncRecallIndex(index, sessions, { loadTranscript: (id, agent) => loadSessionTranscript(id, agent as never) });
        return (r.indexed + r.removed) > 0 ? "warmed" : "hit";
      } finally { index.close(); }
    },
  },
  {
    id: "insights", cost: "llm", scope: "per-root",
    async warm(root, { dir, force }) {
      const r = await computeInsights(root as string, { dir, force });
      return r.cached ? "hit" : "warmed";
    },
  },
  {
    id: "analyze", cost: "llm", scope: "per-root",
    async warm(root, { dir, force }) {
      const r = await computeWorkflowAnalysis(root as string, { dir, force });
      return r.cached ? "hit" : "warmed";
    },
  },
  {
    id: "distill", cost: "llm", scope: "per-root",
    async warm(root, { dir, force }) {
      // Generous per-run budget so the capped distill (~50s/skill) actually
      // completes and caches, rather than timing out into a degraded result.
      const r = await computeDistill(root as string, { dir, force, timeoutMs: DISTILL_BACKGROUND_TIMEOUT_MS });
      return r.cached ? "hit" : "warmed";
    },
  },
  {
    id: "dream", cost: "llm", scope: "per-root",
    async warm(root, { dir }) {
      return dreamRoot(root as string, { dir });
    },
  },
];
