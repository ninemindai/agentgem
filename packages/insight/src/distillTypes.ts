// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/distillTypes.ts
//
// Shared distillation types. Extracted from distill.ts so that extract.ts (the
// deterministic seam) and distill.ts (the LLM orchestration) can both depend on
// the types WITHOUT depending on each other — the seam carries a
// `skeleton: DistilledSkill` and distill.ts imports `extractCandidates`, which
// would otherwise be a cycle. Pure types; no runtime code.
import type { ProcedureGroup, SessionSequence } from "./workflowScan.js";

// One source location a procedure/reflection was observed at. COORDINATES ONLY —
// never raw message content (privacy boundary). `messageIndices` are JSONL line
// indices within the transcript named by `transcript` (basename).
export interface Occurrence {
  sessionId: string;
  transcript: string;       // basename, not an absolute path
  messageIndices: number[];
  atMs: number;
}
export interface Provenance { occurrences: Occurrence[] }

// A second, non-skill signal: a recurring pattern that is not itself distilled
// into a skill. `recurring-decision` is reserved (see plan Task 6 note) and not
// emitted yet.
export interface Reflection {
  kind: "unresolved-task" | "recurring-pattern" | "recurring-decision";
  detail: string;           // scrubbed, human-readable
  importance: "high" | "medium";
  provenance: Provenance;
}

// A procedure that passed the deterministic Phase-0 gate, with one representative
// scrubbed run (+ its mission hint) attached. This is what `distillCandidates`
// returns — before the seam enriches it.
export interface GatedCandidate extends ProcedureGroup {
  sample: SessionSequence;
}

// A gated candidate enriched by the extractor seam (extract.ts): source
// provenance, a deterministic skeleton draft, and a precision prior.
export interface ProcedureCandidate extends GatedCandidate {
  provenance: Provenance;
  skeleton: DistilledSkill;
  priorConfidence: "high" | "medium" | "low";
}

// A distilled skill: the workflow capture, as a DRAFT. `origin` distinguishes an
// LLM-enriched draft from a deterministic skeleton (heuristic fallback).
export interface DistilledSkill {
  name: string;
  description: string;
  triggers: string[];
  tools: string[];
  mutating: boolean;
  body: string;
  evidence: { sessions: number; exampleSequence: string[]; root: string; provenance: Provenance };
  status: "draft";
  confidence: "high" | "medium" | "low";
  origin: "llm" | "heuristic";
}
