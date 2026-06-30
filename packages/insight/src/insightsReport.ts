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
  narrative: string;            // cross-session prose; deterministic here, upgraded by narrateInsights
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
  return { totals, outcomes_summary, narrative: templateNarrative(totals, publish_candidates), friction, publish_candidates };
}

// Deterministic baseline narrative — a factual one-liner from the stats. The
// agent pass (narrateInsights) upgrades this to a real characterization; this is
// the honest fallback when the agent is unavailable.
function templateNarrative(
  totals: InsightsReport["totals"],
  publish: PublishCandidate[],
): string {
  if (totals.sessions === 0) return "No sessions analyzed yet — nothing to characterize.";
  const parts = [`Across ${totals.sessions} session(s), ${totals.mostly} mostly succeeded`];
  if (totals.partially) parts.push(`${totals.partially} were partial`);
  if (totals.not) parts.push(`${totals.not} fell short`);
  let s = parts.join(", ") + ".";
  if (publish.length) s += ` ${publish.length} look worth publishing — e.g. "${publish[0].goal}".`;
  return s;
}
