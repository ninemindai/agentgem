// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Per-session process-quality: detector findings + stage profile folded into a
// deterministic 0–100 score. Motivated by AgentLens (arXiv:2605.12925): outcome-
// only grading misses lucky passes, so grade the process. Deliberately NOT a
// learned model — every deduction is traceable to a finding the UI can show.
import type { SessionSequence, WorkflowSignal } from "./workflowScan.js";
import type { DetectorFinding } from "./detectors.js";
import { stageProfile, type StageProfile } from "./stageLabels.js";

export type ProcessLabel = "disciplined" | "loose" | "chaotic";

export interface ProcessQuality {
  sessionId: string;
  transcript: string;      // basename provenance, mirrors DetectorFinding
  score: number;           // 0–100
  label: ProcessLabel;     // ≥80 disciplined · ≥50 loose · else chaotic
  stages: StageProfile;
}

const WARN_COST = 20;
const INFO_COST = 10;

export function sessionProcessQuality(session: SessionSequence, findings: DetectorFinding[]): ProcessQuality {
  let score = 100;
  for (const f of findings) {
    if (f.sessionId !== session.sessionId) continue;
    score -= f.severity === "warn" ? WARN_COST : INFO_COST;
  }
  score = Math.max(0, score);
  const label: ProcessLabel = score >= 80 ? "disciplined" : score >= 50 ? "loose" : "chaotic";
  return { sessionId: session.sessionId, transcript: session.transcript, score, label, stages: stageProfile(session.steps) };
}

/** Fold a whole signal: one ProcessQuality per retained session, plus the share
 *  of sessions that are not disciplined (the local analog of AgentLens's lucky
 *  rate — process risk, with no claim about task success we cannot observe). */
export function processQualityReport(
  signal: WorkflowSignal, findings: DetectorFinding[],
): { sessions: ProcessQuality[]; atRiskRate: number } {
  const sessions = (signal.sequences?.sessions ?? []).map((s) => sessionProcessQuality(s, findings));
  const atRisk = sessions.filter((q) => q.label !== "disciplined").length;
  return { sessions, atRiskRate: sessions.length ? atRisk / sessions.length : 0 };
}
