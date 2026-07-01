// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/workflowCore.ts
//
// Headless, cache-aware core for the Curate workflow analysis. Shared by the SSE
// endpoint (src/workflowStream.ts) and the background warmer.
import { introspectConfig, introspectProject } from "@agentgem/capture";
import { resolveDirs, resolveProject } from "@agentgem/model";
import {
  claudeTranscriptsForCwd, scanWorkflow,
  recommendWorkflow, recommendationToSelection, distillWorkflow,
  extractReflections, writeReflections,
  transcriptToken, readAnalysisCacheEntry, writeAnalysisCache,
} from "@agentgem/insight";

export interface WorkflowAnalysisPayload {
  candidates: unknown[]; gaps: string[]; distilled: unknown; reflections: unknown[];
  signalSummary: { sessionsScanned: number; spanDays: number; notes: unknown };
  degraded: boolean;
}
export interface WorkflowAnalysisResult { payload: WorkflowAnalysisPayload; cached: boolean; updatedAt: number | null }

export async function computeWorkflowAnalysis(
  root: string,
  opts: {
    dir?: string; force?: boolean; now?: () => number;
    progress?: { onPhase?(phase: string, extra?: Record<string, unknown>): void; onDelta?(text: string): void };
    recommend?: typeof recommendWorkflow;
    distill?: typeof distillWorkflow;
  } = {},
): Promise<WorkflowAnalysisResult> {
  const now = opts.now ?? Date.now;
  const p = opts.progress;
  const dirs = resolveDirs(opts.dir);
  const project = introspectProject(resolveProject(root));
  const globalInv = introspectConfig(dirs);
  const scanInv = { project, global: { skills: globalInv.skills, mcpServers: globalInv.mcpServers, hooks: globalInv.hooks } };

  p?.onPhase?.("scanning");
  const paths = claudeTranscriptsForCwd(dirs.claudeDir, root);
  const token = transcriptToken(paths);
  if (!opts.force) {
    const entry = readAnalysisCacheEntry(root, token);
    if (entry) return { payload: entry.result as WorkflowAnalysisPayload, cached: true, updatedAt: entry.ts };
  }

  const signal = scanWorkflow(paths, scanInv, { retainSequences: true });
  p?.onPhase?.("scanned", { transcripts: paths.length, sessions: signal.sessions.scanned });

  p?.onPhase?.("thinking");
  const [{ analysis, degraded }, distill] = await Promise.all([
    (opts.recommend ?? recommendWorkflow)(signal, scanInv, { onDelta: (chunk) => p?.onDelta?.(chunk) }),
    (opts.distill ?? distillWorkflow)(signal, scanInv),
  ]);

  p?.onPhase?.("validating");
  const reflections = extractReflections(signal);
  writeReflections(reflections, root);   // best-effort; ignore the path
  const gaps = [...analysis.gaps, ...reflections.filter((r) => r.importance === "high").map((r) => r.detail)];
  const candidates = analysis.candidates.map((c) => ({ ...c, selection: recommendationToSelection(c) }));
  const anyDegraded = degraded || distill.degraded;
  const payload: WorkflowAnalysisPayload = {
    candidates, gaps, distilled: distill.distilled, reflections,
    signalSummary: { sessionsScanned: signal.sessions.scanned, spanDays: signal.sessions.spanDays, notes: signal.notes },
    degraded: anyDegraded,
  };
  let updatedAt: number | null = null;
  if (!anyDegraded) { const ts = now(); writeAnalysisCache(root, token, payload, ts); updatedAt = ts; }
  return { payload, cached: false, updatedAt };
}
