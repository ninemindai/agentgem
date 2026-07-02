// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/warm/registry.ts
//
// The v1 warmable inventory. Each warm() is cache-aware and returns whether it
// recomputed ("warmed") or found a fresh cache entry ("hit"). Global/aggregate
// warmables ignore the root argument; per-root warmables receive a project root.
import { resolveDirs } from "@agentgem/model";
// usage scan + its cache live in @agentgem/capture:
import { computeGlobalUsage, readGlobalUsageCache, writeGlobalUsageCache } from "@agentgem/capture";
// transcript helpers + the analysis cache live in @agentgem/insight:
import { allClaudeTranscripts, transcriptToken, readAnalysisCache, writeAnalysisCache } from "@agentgem/insight";
import { collectScorecard, selectScorecardRoots, scorecardTranscriptPaths, defaultScorecardDeps } from "../gem/scorecard.js";
import { SCORECARD_CACHE_ROOT } from "../scorecardStream.js";
import { computeInsights } from "../insightsCore.js";
import { computeWorkflowAnalysis } from "../workflowCore.js";
import { dreamRoot } from "../dream/dreamPass.js";

export type WarmStatusValue = "warmed" | "hit";
export interface Warmable {
  id: "usage" | "scorecard" | "insights" | "analyze" | "dream";
  cost: "cheap" | "llm";
  scope: "global" | "per-root";
  warm(root: string | null, opts: { dir?: string; force?: boolean }): Promise<WarmStatusValue>;
}

export const WARMABLES: Warmable[] = [
  {
    id: "usage", cost: "cheap", scope: "global",
    async warm(_root, { dir, force }) {
      const dirs = resolveDirs(dir);
      const paths = allClaudeTranscripts(dirs.claudeDir);
      const token = transcriptToken(paths);
      if (!force && readGlobalUsageCache(token)) return "hit";
      writeGlobalUsageCache(token, computeGlobalUsage(dirs, paths), dirs.claudeDir);
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
    id: "dream", cost: "llm", scope: "per-root",
    async warm(root, { dir }) {
      return dreamRoot(root as string, { dir });
    },
  },
];
