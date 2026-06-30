// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/insightsReport.ts
//
// Cross-session synthesis: folds per-session SessionFacets (each already an LLM
// judgment) into one report. Pure and deterministic — like scorecard.ts, no fs,
// no LLM. The facets carry the prose; this assembles it. The wedge over Claude
// Code's /insights: the report ends in `publish_candidates` — the succeeded,
// reusable sessions worth publishing as Gems — not config tweaks.
import type { SessionFacet } from "./facets.js";

export interface PublishCandidate { sessionId: string; goal: string; why: string }
export interface FrictionTheme { sessionId: string; detail: string }
export interface InsightsReport {
  totals: { sessions: number; mostly: number; partially: number; not: number };
  outcomes_summary: string;
  friction: FrictionTheme[];
  publish_candidates: PublishCandidate[];
}

export function synthesizeInsights(facets: SessionFacet[]): InsightsReport {
  const totals = {
    sessions: facets.length,
    mostly: facets.filter((f) => f.outcome === "mostly_achieved").length,
    partially: facets.filter((f) => f.outcome === "partially_achieved").length,
    not: facets.filter((f) => f.outcome === "not_achieved").length,
  };
  const outcomes_summary = `${totals.sessions} session(s): ${totals.mostly} mostly achieved, ` +
    `${totals.partially} partial, ${totals.not} not achieved.`;
  const friction: FrictionTheme[] = facets
    .filter((f) => f.friction_detail.trim() !== "")
    .map((f) => ({ sessionId: f.sessionId, detail: f.friction_detail }));
  // The goldmine CTA: sessions that succeeded are the ones worth publishing.
  const publish_candidates: PublishCandidate[] = facets
    .filter((f) => f.outcome === "mostly_achieved")
    .map((f) => ({ sessionId: f.sessionId, goal: f.underlying_goal, why: `Succeeded: ${f.brief_summary}` }));
  return { totals, outcomes_summary, friction, publish_candidates };
}
