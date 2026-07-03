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
import { createLogger } from "@agentgem/base";

const log = createLogger("insight");

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

const EDIT_RE = /^(Edit|Write|NotebookEdit)$/;
// "Did they check their work?" — matched against `${verb} ${arg}` of Bash steps.
const VERIFY_RE = /\b(tests?|vitest|jest|pytest|tsc|build|lint|typecheck|check)\b/i;

function isEdit(s: ProcedureStep): boolean { return EDIT_RE.test(s.verb); }
function isVerify(s: ProcedureStep): boolean {
  return s.verb.startsWith("Bash:") && VERIFY_RE.test(`${s.verb} ${s.arg}`);
}

// Same file edited + same command re-run this many consecutive cycles reads as
// grinding on one spot. Healthy TDD moves across files/tests; thrash doesn't.
export const THRASH_MIN_CYCLES = 4;

const thrashLoop: DetectorSpec = {
  id: "thrash-loop",
  title: "Edit→verify ground loop on one file",
  cost: "cheap",
  severity: "warn",
  advice: "After a few failed edit→test rounds on the same file, stop editing: reproduce the failure in isolation, read the full error, and re-state your hypothesis before the next change.",
  detect(session) {
    interface Cycle { file: string; cmd: string; msgIndices: [number, number] }
    const cycles: Cycle[] = [];
    let pendingEdit: ProcedureStep | null = null;
    for (const s of session.steps) {
      if (isEdit(s)) pendingEdit = s;
      else if (pendingEdit && isVerify(s)) {
        cycles.push({ file: pendingEdit.arg, cmd: `${s.verb} ${s.arg}`, msgIndices: [pendingEdit.msgIndex, s.msgIndex] });
        pendingEdit = null;
      }
    }
    const out: DetectorFinding[] = [];
    let i = 0;
    while (i < cycles.length) {
      let j = i + 1;
      while (j < cycles.length && cycles[j].file === cycles[i].file && cycles[j].cmd === cycles[i].cmd) j++;
      if (j - i >= THRASH_MIN_CYCLES) {
        out.push(mkFinding(thrashLoop, session,
          `edit→verify on one file repeated ${j - i}x without progress elsewhere`,
          cycles.slice(i, j).flatMap((c) => c.msgIndices)));
      }
      i = j;
    }
    return out;
  },
};

const noVerifyFinish: DetectorSpec = {
  id: "no-verify-finish",
  title: "Edits with no verification afterwards",
  cost: "cheap",
  severity: "info",
  advice: "End sessions that changed code with a verification step — run the tests or build so the change is confirmed working, not assumed working.",
  detect(session) {
    let lastEditIdx = -1;
    let edits = 0;
    session.steps.forEach((s, idx) => { if (isEdit(s)) { edits++; lastEditIdx = idx; } });
    if (edits === 0) return [];
    const verifiedAfter = session.steps.some((s, idx) => idx > lastEditIdx && isVerify(s));
    if (verifiedAfter) return [];
    return [mkFinding(noVerifyFinish, session,
      `${edits} edit step(s) with no test/build run afterwards`,
      [session.steps[lastEditIdx].msgIndex])];
  },
};

export const DETECTORS: DetectorSpec[] = [retryStorm, thrashLoop, noVerifyFinish];

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
      catch (err) { log.warn("detector %s failed: %s", spec.id, (err as Error)?.message ?? err); }
    }
  }
  return out;
}

// One row per detector id that actually fired — the aggregation the coaching
// layer consumes. Carries title/advice so HTTP consumers need no registry.
export interface DetectorSummary {
  id: string;
  title: string;
  advice: string;
  severity: DetectorSeverity;
  count: number;      // total findings
  sessions: number;   // distinct sessions it fired in
}

export function summarizeFindings(findings: DetectorFinding[], specs: DetectorSpec[] = DETECTORS): DetectorSummary[] {
  const byId = new Map(specs.map((s) => [s.id, s]));
  const acc = new Map<string, { severity: DetectorSeverity; count: number; sessions: Set<string> }>();
  for (const f of findings) {
    const a = acc.get(f.detectorId) ?? { severity: f.severity, count: 0, sessions: new Set<string>() };
    a.count++;
    a.sessions.add(f.sessionId);
    acc.set(f.detectorId, a);
  }
  return [...acc.entries()]
    .map(([id, a]) => {
      const spec = byId.get(id);
      return {
        id, title: spec?.title ?? id, advice: spec?.advice ?? "",
        severity: spec?.severity ?? a.severity, count: a.count, sessions: a.sessions.size,
      };
    })
    .sort((x, y) => y.count - x.count || x.id.localeCompare(y.id));
}
