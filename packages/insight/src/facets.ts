// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/facets.ts
//
// Per-session "facets": a typed judgment of what each session was trying to do
// and how it went. The agent (judgeSessions) produces these; this module owns
// the type, the deterministic fallback (one neutral facet per missioned session,
// never throws), and validation of an agent response against the signal (the
// source of truth for which sessions exist). Mirrors the validateAnalysis /
// deterministicAnalysis pattern in acpRecommender.ts.
import type { WorkflowSignal, SessionSequence } from "./workflowScan.js";

export type SessionOutcome = "mostly_achieved" | "partially_achieved" | "not_achieved";

export interface SessionFacet {
  sessionId: string;
  transcript: string;          // basename, provenance — backfilled from the signal
  atMs: number;
  underlying_goal: string;     // prose: what the user was trying to accomplish
  brief_summary: string;
  outcome: SessionOutcome;
  friction_detail: string;     // "" = none observed
  model?: string;              // dominant model in the session — backfilled from the signal
  origin: "llm" | "heuristic"; // heuristic = deterministic fallback (no agent)
}

const OUTCOMES: ReadonlySet<string> = new Set<SessionOutcome>([
  "mostly_achieved", "partially_achieved", "not_achieved",
]);

// Sessions carrying a mission hint, indexed by id (the validatable universe).
function missionedSessions(signal: WorkflowSignal): SessionSequence[] {
  return (signal.sequences?.sessions ?? []).filter((s) => s.missionHint);
}

// One neutral facet per missioned session. The deterministic path cannot judge
// outcome without the agent, so it reports the honest neutral default.
export function deterministicFacets(signal: WorkflowSignal): SessionFacet[] {
  return missionedSessions(signal).map((s) => ({
    sessionId: s.sessionId,
    transcript: s.transcript,
    atMs: s.atMs,
    underlying_goal: s.missionHint!.task,
    brief_summary: s.missionHint!.task,
    outcome: "partially_achieved",
    friction_detail: "",
    model: s.model,
    origin: "heuristic",
  }));
}

// Pull the first {...} block out of a message that may wrap JSON in prose/fences.
function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

/**
 * Validate an agent response against the signal. Each facet's sessionId must
 * resolve to a real missioned session; provenance (transcript/atMs) is backfilled
 * from the signal, never trusted from the agent. Hallucinated ids, bad outcome
 * enums, and non-string prose are dropped. On structural failure or zero
 * survivors, fall back to deterministicFacets — the signal is authoritative.
 */
export function validateFacets(raw: unknown, signal: WorkflowSignal): SessionFacet[] {
  const fallback = deterministicFacets(signal);
  let obj: any = raw;
  if (typeof raw === "string") { try { obj = JSON.parse(extractJson(raw)); } catch { return fallback; } }
  if (!obj || typeof obj !== "object" || !Array.isArray(obj.facets)) return fallback;

  const byId = new Map(missionedSessions(signal).map((s) => [s.sessionId, s]));
  const out: SessionFacet[] = [];
  for (const f of obj.facets) {
    if (!f || typeof f !== "object") continue;
    const sess = byId.get(f.sessionId);
    if (!sess) continue;                                   // hallucinated / unknown session
    if (!OUTCOMES.has(f.outcome)) continue;                // bad enum
    if (typeof f.underlying_goal !== "string" || typeof f.brief_summary !== "string") continue;
    out.push({
      sessionId: sess.sessionId,
      transcript: sess.transcript,
      atMs: sess.atMs,
      underlying_goal: f.underlying_goal,
      brief_summary: f.brief_summary,
      outcome: f.outcome,
      friction_detail: typeof f.friction_detail === "string" ? f.friction_detail : "",
      model: sess.model,                                     // from the signal, never the agent
      origin: "llm",
    });
  }
  return out.length ? out : fallback;
}
