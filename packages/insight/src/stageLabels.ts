// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// AgentLens-style intent stages over verb spines (arXiv:2605.12925 labels agent
// actions Exploration / Implementation / Verification / Orchestration). Pure —
// the single home of the step-classification predicates; detectors.ts imports
// isEdit/isVerify from here so both layers agree on what "an edit" is.
import type { ProcedureStep } from "./workflowScan.js";

export type IntentStage = "exploration" | "implementation" | "verification" | "orchestration" | "other";
export interface StageProfile { exploration: number; implementation: number; verification: number; orchestration: number; other: number }

export const EDIT_RE = /^(Edit|Write|NotebookEdit)$/;
// "Did they check their work?" — matched against `${verb} ${arg}` of Bash steps.
export const VERIFY_RE = /\b(tests?|vitest|jest|pytest|tsc|build|lint|typecheck|check)\b/i;

const EXPLORE_TOOL_RE = /^(Read|Grep|Glob|LS|NotebookRead|WebFetch|WebSearch)$/;
const EXPLORE_BASH_RE = /\b(ls|cat|head|tail|grep|rg|find|tree|git (log|show|diff|status|blame))\b/;
const ORCHESTRATE_RE = /^(Task|Agent)$/;

export function isEdit(s: ProcedureStep): boolean { return EDIT_RE.test(s.verb); }
export function isVerify(s: ProcedureStep): boolean {
  return s.verb.startsWith("Bash:") && VERIFY_RE.test(`${s.verb} ${s.arg}`);
}

export function stageOf(s: ProcedureStep): IntentStage {
  if (ORCHESTRATE_RE.test(s.verb)) return "orchestration";
  if (isEdit(s)) return "implementation";
  if (isVerify(s)) return "verification";
  if (EXPLORE_TOOL_RE.test(s.verb)) return "exploration";
  if (s.verb.startsWith("Bash:") && EXPLORE_BASH_RE.test(`${s.verb} ${s.arg}`)) return "exploration";
  return "other";
}

export function stageProfile(steps: ProcedureStep[]): StageProfile {
  const p: StageProfile = { exploration: 0, implementation: 0, verification: 0, orchestration: 0, other: 0 };
  for (const s of steps) p[stageOf(s)]++;
  return p;
}
