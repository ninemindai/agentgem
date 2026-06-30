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

// A distilled LESSON: a salient learning rendered as draft instructions. Mirrors
// DistilledSkill (status:"draft", evidence carries the coordinates-only provenance),
// but source-agnostic — provenance may span one or many sessions, no recurrence assumed.
export interface DistilledLesson {
  name: string;          // kebab slug, path-safe
  body: string;          // the scrubbed lesson text (already privacy-safe)
  importance: "high" | "medium";
  status: "draft";
  evidence: { sessions: number; root: string; provenance: Provenance };
}

export function lessonSlug(detail: string): string {
  const slug = detail.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .split("-").filter(Boolean).slice(0, 6).join("-");
  return slug || "lesson";
}

// One reflection → one draft lesson. `root` is the analyze project root (a Reflection
// carries no root). `unresolved-task` is a personal gap, not a shareable lesson → null.
export function reflectionToLesson(r: Reflection, root: string): DistilledLesson | null {
  if (r.kind === "unresolved-task") return null;
  const sessions = new Set(r.provenance.occurrences.map((o) => o.sessionId)).size;
  return { name: lessonSlug(r.detail), body: r.detail, importance: r.importance, status: "draft",
    evidence: { sessions, root, provenance: r.provenance } };
}

// Batch adapter: map → drop nulls → de-duplicate names (collision-suffix -2, -3, …).
export function reflectionsToLessons(reflections: Reflection[], root: string): DistilledLesson[] {
  const out: DistilledLesson[] = [];
  const seen = new Map<string, number>();
  for (const r of reflections) {
    const l = reflectionToLesson(r, root);
    if (!l) continue;
    const n = seen.get(l.name) ?? 0;
    seen.set(l.name, n + 1);
    out.push(n === 0 ? l : { ...l, name: `${l.name}-${n + 1}` });
  }
  return out;
}
