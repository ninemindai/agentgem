// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/insightsCore.ts
//
// Headless, cache-aware core for the personal session-insights report. Both the
// SSE route (src/insights.controller.ts) and the background warmer call this so
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
  openArtifactOutcomesStore, buildArtifactOutcomeRows,
  type ArtifactOutcomesStore, type WorkflowSignal, type SessionFacet,
} from "@agentgem/insight";

/** Persist the {artifact, session, outcome} triples for a judged pass. Isolated
 *  and exported so it is unit-testable without running the whole insights loop.
 *  Does NOT swallow — the caller wraps it best-effort so a store error never
 *  breaks insights. */
export function persistOutcomes(
  store: ArtifactOutcomesStore,
  signal: WorkflowSignal,
  facets: SessionFacet[],
  project: string | null,
): void {
  const rows = buildArtifactOutcomeRows(signal, facets, { project, agent: null });
  const bySession = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = bySession.get(r.sessionId) ?? [];
    list.push(r);
    bySession.set(r.sessionId, list);
  }
  for (const [sessionId, sessionRows] of bySession) store.upsertSession(sessionId, sessionRows);
}

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
    openOutcomesStore?: () => ArtifactOutcomesStore;
  } = {},
): Promise<InsightsResult> {
  const now = opts.now ?? Date.now;
  const p = opts.progress;
  const dirs = resolveDirs(opts.dir);
  const allProjects = root === "*";
  const scanInv = allProjects
    ? { project: { root: "*", name: "All projects", skills: [], mcpServers: [], hooks: [], instructions: [], subagents: [] } }
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

      // Persist proven-use triples (best-effort — never break insights on a store error).
      try {
        const outcomesStore = (opts.openOutcomesStore ?? openArtifactOutcomesStore)();
        try { persistOutcomes(outcomesStore, signal, facets, signal.sequences?.root ?? null); }
        finally { outcomesStore.close(); }
      } catch { /* outcomes are an enhancement, not a correctness dependency */ }

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
