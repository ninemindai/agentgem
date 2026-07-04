// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/insightsCore.ts
//
// Headless, cache-aware core for the personal session-insights report. Both the
// SSE endpoint (src/insightsStream.ts) and the background warmer call this so
// they cache identically. Progress is optional callbacks; the warmer passes none.
import { introspectConfig, introspectProject } from "@agentgem/capture";
import { resolveDirs, resolveProject } from "@agentgem/model";
import {
  claudeTranscriptsForCwd, allClaudeTranscripts, scanWorkflow,
  judgeSessions, synthesizeInsights, narrateInsights,
  insightsToken, readInsightsCacheEntry, writeInsightsCache,
  runDetectors, summarizeFindings, loadRuleDetectors, DETECTORS,
  computeCached, type CacheHit,
  type DetectorFinding, type DetectorSummary,
} from "@agentgem/insight";

export interface InsightsPayload {
  report: ReturnType<typeof synthesizeInsights>;
  facets: Awaited<ReturnType<typeof judgeSessions>>["facets"];
  findings: DetectorFinding[];
  detectorSummary: DetectorSummary[];
  degraded: boolean;
  signalSummary: { sessionsScanned: number; spanDays: number; notes: unknown };
}
export interface InsightsProgress {
  onPhase?(phase: string, extra?: Record<string, unknown>): void;
  onDelta?(text: string): void;
}
export interface InsightsResult { payload: InsightsPayload; cached: boolean; updatedAt: number | null }

export async function computeInsights(
  root: string,
  opts: {
    dir?: string; force?: boolean; cacheOnly?: boolean; progress?: InsightsProgress; now?: () => number;
    judge?: typeof judgeSessions;
    narrate?: typeof narrateInsights;
  } = {},
): Promise<InsightsResult> {
  const now = opts.now ?? Date.now;
  const p = opts.progress;
  const dirs = resolveDirs(opts.dir);
  const allProjects = root === "*";
  const scanInv = allProjects
    ? { project: { root: "*", name: "All projects", skills: [], mcpServers: [], hooks: [], instructions: [] } }
    : (() => {
        const project = introspectProject(resolveProject(root));
        const globalInv = introspectConfig(dirs);
        return { project, global: { skills: globalInv.skills, mcpServers: globalInv.mcpServers, hooks: globalInv.hooks } };
      })();

  p?.onPhase?.("scanning");
  const paths = allProjects ? allClaudeTranscripts(dirs.claudeDir) : claudeTranscriptsForCwd(dirs.claudeDir, root);
  const token = insightsToken(paths);

  return computeCached<InsightsPayload>({
    token, force: opts.force, now,
    read: (t) => readInsightsCacheEntry(root, t) as CacheHit<InsightsPayload> | null,
    write: (t, payload, ts) => writeInsightsCache(root, t, payload, ts),
    degraded: (p) => p.degraded,
    cacheOnly: opts.cacheOnly,
    // Cache miss + cached-only caller (the dream harvest) — empty report without
    // judging/synthesizing, so the harvest never spends LLM.
    onCacheOnlyMiss: () => ({ report: synthesizeInsights([]), facets: [], findings: [], detectorSummary: [], degraded: false, signalSummary: { sessionsScanned: 0, spanDays: 0, notes: null } }),
    compute: async () => {
      const signal = scanWorkflow(paths, scanInv, { retainSequences: true });
      p?.onPhase?.("scanned", { transcripts: paths.length, sessions: signal.sessions.scanned });

      p?.onPhase?.("detecting");
      const ruleSpecs = loadRuleDetectors();
      const findings = runDetectors(signal, ruleSpecs);
      const detectorSummary = summarizeFindings(findings, [...DETECTORS, ...ruleSpecs]);

      p?.onPhase?.("judging");
      const { facets, degraded: judgeDegraded } = await (opts.judge ?? judgeSessions)(signal, { onDelta: (chunk) => p?.onDelta?.(chunk) });

      p?.onPhase?.("synthesizing");
      const report = synthesizeInsights(facets);

      p?.onPhase?.("narrating");
      const narr = await (opts.narrate ?? narrateInsights)(facets, report.narrative, { onDelta: (chunk) => p?.onDelta?.(chunk) });
      report.narrative = narr.narrative;

      return {
        report, facets, findings, detectorSummary,
        degraded: judgeDegraded || narr.degraded,
        signalSummary: { sessionsScanned: signal.sessions.scanned, spanDays: signal.sessions.spanDays, notes: signal.notes },
      };
    },
  });
}
