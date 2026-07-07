// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Deterministic per-session aggregate for the goldmine chat: process-quality
// score, stage profile, that session's detector findings, metrics, and a
// counts-only event skeleton. NO message/tool content and NO file paths ever
// leave here — every field is a number, a score, or a low-cardinality name.
// Deep analysis (process/stages/findings/events) runs on the Claude tool-verb
// spine, mirroring behaviorFindings; metrics are multi-agent. Never throws.
import { resolveDirs } from "@agentgem/model";
import { scanSessionsCached } from "./observeScan.js";
import { resolveClaudeSession } from "./inspectSession.js";
import { scanWorkflow } from "./workflowScan.js";
import type { SessionSequence, ProcedureStep } from "./workflowScan.js";
import { runDetectors, summarizeFindings } from "./detectors.js";
import type { DetectorSummary } from "./detectors.js";
import { loadRuleDetectors } from "./detectorRules.js";
import { sessionProcessQuality } from "./processQuality.js";
import { stageProfile, isEdit, isVerify } from "./stageLabels.js";
import type { StageProfile } from "./stageLabels.js";

export interface SessionSummary {
  sessionId: string;
  agent: string;
  project: string | null;
  model: string | null;
  gitBranch: string | null;
  startMs: number; endMs: number; durationMs: number;
  msgs: number; tokensIn: number; tokensOut: number; tokensCache: number;
  process: { score: number; label: "disciplined" | "loose" | "chaotic"; stages: StageProfile } | null;
  findings: DetectorSummary[];
  events: { toolCalls: { name: string; count: number }[]; filesTouched: number; edits: number; verifications: number } | null;
}

// Counts-only event skeleton from a scrubbed verb spine. `s.verb` is the tool
// verb (e.g. "Edit", "Bash:pnpm"); `s.tool` is the raw tool name. We count tool
// names and edit/verify steps, and the number of DISTINCT edited/read file args
// (count only — the arg strings themselves never leave this function).
function eventSkeleton(steps: ProcedureStep[]): NonNullable<SessionSummary["events"]> {
  const byTool = new Map<string, number>();
  const files = new Set<string>();
  let edits = 0, verifications = 0;
  for (const s of steps) {
    byTool.set(s.tool, (byTool.get(s.tool) ?? 0) + 1);
    if (isEdit(s)) { edits++; if (s.arg) files.add(s.arg); }
    if (isVerify(s)) verifications++;
  }
  const toolCalls = [...byTool.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { toolCalls, filesTouched: files.size, edits, verifications };
}

export async function summarizeSession(
  sessionId: string,
  agent: string,
  dirs?: { claudeDir?: string; codexDir?: string },
): Promise<SessionSummary | null> {
  try {
    // 1. Metrics from the metadata scan (multi-agent, no content).
    const stats = await scanSessionsCached(Date.now(), dirs);
    const meta = stats.find((s) => s.sessionId === sessionId && s.agent === agent)
      ?? stats.find((s) => s.sessionId === sessionId);
    if (!meta) return null;

    const base: SessionSummary = {
      sessionId, agent: meta.agent, project: meta.project, model: meta.model, gitBranch: meta.gitBranch,
      startMs: meta.startMs, endMs: meta.endMs, durationMs: Math.max(0, meta.endMs - meta.startMs),
      msgs: meta.msgs, tokensIn: meta.tokensIn, tokensOut: meta.tokensOut, tokensCache: meta.tokensCache,
      process: null, findings: [], events: null,
    };

    // 2. Deep analysis is Claude-spine only — gate on the session's ACTUAL agent
    //    (meta.agent), not the caller's hint, so a correctly-identified Claude
    //    session is always analyzable.
    if (meta.agent !== "claude") return base;
    const resolved = await resolveClaudeSession(sessionId, { claudeDir: resolveDirs(dirs?.claudeDir).claudeDir });
    if (!resolved) return base;

    const inv = { project: { root: "*", name: "All projects", skills: [], mcpServers: [], hooks: [], instructions: [] } };
    const signal = scanWorkflow([resolved.path], inv, { retainSequences: true });
    const seq: SessionSequence | undefined = signal.sequences?.sessions.find((s) => s.sessionId === sessionId)
      ?? signal.sequences?.sessions[0];
    if (!seq) return base;

    const findings = runDetectors(signal, loadRuleDetectors());
    const pq = sessionProcessQuality(seq, findings);
    return {
      ...base,
      process: { score: pq.score, label: pq.label, stages: stageProfile(seq.steps) },
      findings: summarizeFindings(findings.filter((f) => f.sessionId === sessionId)),
      events: eventSkeleton(seq.steps),
    };
  } catch { return null; }
}
