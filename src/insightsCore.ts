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
} from "@agentgem/insight";

export interface InsightsPayload {
  report: ReturnType<typeof synthesizeInsights>;
  facets: Awaited<ReturnType<typeof judgeSessions>>["facets"];
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

  if (!opts.force) {
    const entry = readInsightsCacheEntry(root, token);
    if (entry) return { payload: entry.result as InsightsPayload, cached: true, updatedAt: entry.ts };
  }
  if (opts.cacheOnly) {
    // Cache miss + cached-only caller (the dream harvest) — return an empty report without
    // judging/synthesizing, so the harvest never spends LLM.
    return { payload: { report: synthesizeInsights([]), facets: [], degraded: false, signalSummary: { sessionsScanned: 0, spanDays: 0, notes: null } }, cached: false, updatedAt: null };
  }

  const signal = scanWorkflow(paths, scanInv, { retainSequences: true });
  p?.onPhase?.("scanned", { transcripts: paths.length, sessions: signal.sessions.scanned });

  p?.onPhase?.("judging");
  const { facets, degraded: judgeDegraded } = await (opts.judge ?? judgeSessions)(signal, { onDelta: (chunk) => p?.onDelta?.(chunk) });

  p?.onPhase?.("synthesizing");
  const report = synthesizeInsights(facets);

  p?.onPhase?.("narrating");
  const narr = await (opts.narrate ?? narrateInsights)(facets, report.narrative, { onDelta: (chunk) => p?.onDelta?.(chunk) });
  report.narrative = narr.narrative;

  const payload: InsightsPayload = {
    report, facets,
    degraded: judgeDegraded || narr.degraded,
    signalSummary: { sessionsScanned: signal.sessions.scanned, spanDays: signal.sessions.spanDays, notes: signal.notes },
  };
  let updatedAt: number | null = null;
  if (!payload.degraded) { const ts = now(); writeInsightsCache(root, token, payload, ts); updatedAt = ts; }
  return { payload, cached: false, updatedAt };
}
