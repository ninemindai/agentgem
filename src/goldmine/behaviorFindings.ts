// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/goldmine/behaviorFindings.ts
//
// Chat-facing policy over the detector engine: run the deterministic pipeline
// (scanWorkflow → runDetectors → summarizeFindings) over a capped window of
// recent transcripts. Pure policy lives here (window, caps); the engine is
// untouched. Never throws — the chat-open path and the MCP tool both call this
// best-effort. LLM-free by construction (detectors are cost:"cheap").
import { resolveDirs } from "@agentgem/model";
import {
  allClaudeTranscripts, safeMtime, scanWorkflow,
  runDetectors, loadRuleDetectors, summarizeFindings, DETECTORS,
} from "@agentgem/insight";
import type { DetectorFinding, DetectorSummary } from "@agentgem/insight";

const DAY = 86_400_000;
const MAX_FINDINGS = 50;

export interface BehaviorFindingsOptions {
  days?: number;           // look-back window, default 14, clamp 1..90
  maxTranscripts?: number; // newest-first cap, default 30, clamp 1..100
  dir?: string;            // claudeDir override (tests)
  rulesDir?: string;       // detector-rules dir override (tests)
  now?: () => number;      // clock seam (tests)
}

export interface BehaviorFindings {
  summary: DetectorSummary[];   // counts from ALL findings (uncapped)
  findings: DetectorFinding[];  // newest sessions first, capped at MAX_FINDINGS
  scanned: { transcripts: number; sessions: number; days: number };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.floor(v)));
}

function empty(days: number): BehaviorFindings {
  return { summary: [], findings: [], scanned: { transcripts: 0, sessions: 0, days } };
}

export function collectBehaviorFindings(opts: BehaviorFindingsOptions = {}): BehaviorFindings {
  const days = clamp(opts.days ?? 14, 1, 90);
  const maxTranscripts = clamp(opts.maxTranscripts ?? 30, 1, 100);
  try {
    const now = (opts.now ?? Date.now)();
    const dirs = resolveDirs(opts.dir);
    const cutoff = now - days * DAY;
    const paths = allClaudeTranscripts(dirs.claudeDir)
      .map((p) => ({ p, ms: safeMtime(p) }))
      .filter((e) => e.ms >= cutoff)
      .sort((a, b) => b.ms - a.ms)
      .slice(0, maxTranscripts)
      .map((e) => e.p);
    if (paths.length === 0) return empty(days);

    // All-projects inventory stub — same shape computeInsights uses for root "*".
    const inv = { project: { root: "*", name: "All projects", skills: [], mcpServers: [], hooks: [], instructions: [] } };
    const signal = scanWorkflow(paths, inv, { retainSequences: true });
    const ruleSpecs = loadRuleDetectors(opts.rulesDir);
    const findings = runDetectors(signal, ruleSpecs);
    return {
      summary: summarizeFindings(findings, [...DETECTORS, ...ruleSpecs]),
      findings: [...findings].sort((a, b) => b.atMs - a.atMs).slice(0, MAX_FINDINGS),
      // sessions = sessions that retained ≥1 step (signal.sessions.scanned is just the transcript count)
      scanned: { transcripts: paths.length, sessions: signal.sequences?.sessions.length ?? 0, days },
    };
  } catch (err) {
    console.error("[behavior] collectBehaviorFindings degraded:", (err as Error).message);
    return empty(days);
  }
}
