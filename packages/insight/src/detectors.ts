// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/detectors.ts
//
// Pluggable session-behavior detectors: a registry of typed specs (the same
// house pattern as WARMABLES / TargetSpec) run over the scrubbed verb spines
// that scanWorkflow retains. Pure — no fs, no LLM. Each detector is a pure
// function SessionSequence -> findings; a broken detector degrades to [] and
// never kills the scan. `id` is an open string on purpose: third-party
// detectors (declarative rules, future Gem packs) must not require touching
// a closed union at every dispatch site.
import type { ProcedureStep, SessionSequence, WorkflowSignal } from "./workflowScan.js";

export type DetectorSeverity = "info" | "warn";

// Coordinates-only evidence (msgIndices into the session transcript), mirroring
// distillTypes.Occurrence. `detail` is built from low-cardinality verbs and
// counts ONLY — never from `arg` (args can carry paths).
export interface DetectorFinding {
  detectorId: string;
  sessionId: string;
  transcript: string;                 // basename provenance — backfilled from the session
  atMs: number;
  severity: DetectorSeverity;
  detail: string;
  evidence: { msgIndices: number[] };
}

export interface DetectorSpec {
  id: string;                         // open string — see module comment
  title: string;
  cost: "cheap" | "llm";              // cheap = pure spine scan; llm reserved for future agent-judged detectors
  severity: DetectorSeverity;
  advice: string;                     // the one canonical improvement suggestion for this pattern
  detect(session: SessionSequence, signal: WorkflowSignal): DetectorFinding[];
}

function mkFinding(
  spec: Pick<DetectorSpec, "id" | "severity">, session: SessionSequence,
  detail: string, msgIndices: number[],
): DetectorFinding {
  return {
    detectorId: spec.id, sessionId: session.sessionId, transcript: session.transcript,
    atMs: session.atMs, severity: spec.severity, detail, evidence: { msgIndices },
  };
}

function sameStep(a: ProcedureStep, b: ProcedureStep): boolean {
  return a.tool === b.tool && a.verb === b.verb && a.arg === b.arg;
}

// The same exact command re-run this many times back-to-back reads as retrying
// without changing anything (steps carry no exit codes, so identical repetition
// is the honest proxy for "retried unchanged").
export const RETRY_STORM_MIN = 3;

const retryStorm: DetectorSpec = {
  id: "retry-storm",
  title: "Same command repeated back-to-back",
  cost: "cheap",
  severity: "warn",
  advice: "When a command doesn't do what you expected, read its full output before re-running it — change one thing per attempt instead of retrying unchanged.",
  detect(session) {
    const out: DetectorFinding[] = [];
    const steps = session.steps;
    let i = 0;
    while (i < steps.length) {
      let j = i + 1;
      while (j < steps.length && sameStep(steps[i], steps[j])) j++;
      if (j - i >= RETRY_STORM_MIN) {
        out.push(mkFinding(retryStorm, session,
          `${steps[i].verb} repeated ${j - i}x back-to-back`,
          steps.slice(i, j).map((s) => s.msgIndex)));
      }
      i = j;
    }
    return out;
  },
};

export const DETECTORS: DetectorSpec[] = [retryStorm];

/**
 * Run every registered detector (plus any extras — e.g. compiled declarative
 * rules) over each retained session. Never throws: a failing detector logs and
 * contributes nothing. Returns findings in (session order, detector order).
 */
export function runDetectors(signal: WorkflowSignal, extra: DetectorSpec[] = []): DetectorFinding[] {
  const sessions = signal.sequences?.sessions ?? [];
  const specs = [...DETECTORS, ...extra];
  const out: DetectorFinding[] = [];
  for (const session of sessions) {
    for (const spec of specs) {
      try { out.push(...spec.detect(session, signal)); }
      catch (err) { console.error(`detector ${spec.id} failed:`, (err as Error).message); }
    }
  }
  return out;
}
