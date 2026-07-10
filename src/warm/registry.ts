// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/warm/registry.ts
//
// The v1 warmable inventory. Each warm() is cache-aware and returns whether it
// recomputed ("warmed") or found a fresh cache entry ("hit"). Global/aggregate
// warmables ignore the root argument; per-root warmables receive a project root.
import { resolveDirs } from "@agentgem/model";
// usage scan + its cache live in @agentgem/capture:
import { computeGlobalUsage, getGlobalUsageIndexed, readGlobalUsageCache, writeGlobalUsageCache } from "@agentgem/capture";
// transcript helpers + the analysis cache live in @agentgem/insight:
import { allClaudeTranscripts, transcriptToken, readAnalysisCache, writeAnalysisCache, scanSessionsCached, isSessionScanFresh, loadSessionTranscript } from "@agentgem/insight";
// recall index sync:
import { RecallIndex, syncRecallIndex } from "@agentgem/recall";
import { defaultRecallDbPath } from "../goldmine/recall.js";
import { collectScorecard, selectScorecardRoots, scorecardTranscriptPaths, defaultScorecardDeps } from "../gem/scorecard.js";
import { SCORECARD_CACHE_ROOT } from "../scorecardStream.js";
import { computeInsights } from "../insightsCore.js";
import { computeWorkflowAnalysis } from "../workflowCore.js";
import { computeDistill, DISTILL_BACKGROUND_TIMEOUT_MS } from "../distillCore.js";
import { dreamRoot } from "../dream/dreamPass.js";

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
      const result = await getGlobalUsageIndexed(dirs, paths).catch(() => computeGlobalUsage(dirs, paths));
      writeGlobalUsageCache(token, result, dirs.claudeDir);
      return "warmed";
    },
  },
  {
    id: "scorecard", cost: "cheap", scope: "global",
    async warm(_root, { dir, force }) {
      const bucket = defaultScorecardDeps.bucketTranscripts(dir);
      const roots = selectScorecardRoots(dir, undefined, defaultScorecardDeps);
      const token = transcriptToken(scorecardTranscriptPaths(roots, bucket));
      if (!force && readAnalysisCache(SCORECARD_CACHE_ROOT, token)) return "hit";
      const sc = collectScorecard(dir, undefined, Date.now(), { bucket });
      if (!sc.degraded) { writeAnalysisCache(SCORECARD_CACHE_ROOT, token, sc, Date.now()); }
      return "warmed";
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
