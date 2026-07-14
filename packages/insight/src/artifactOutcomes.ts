// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// The {artifact, session, outcome} triple: joins each session's fired
// skills/subagents (SessionSequence.eventSeries) to that session's judged
// outcome (SessionFacet) by sessionId — the join both sides already compute in
// one insights pass and which nothing currently persists. Coverage: skill +
// agent kinds only (what SkillAgentEvent carries). The store lives in
// artifactOutcomesStore.ts.
import type { WorkflowSignal } from "./workflowScan.js";
import type { SessionFacet } from "./facets.js";
import type { Outcome } from "./outcomeScore.js";

export interface ArtifactOutcomeRow {
  sessionId: string;
  artifactType: "skill" | "agent";
  artifactName: string;          // raw token from eventSeries (skill token / subagent_type)
  outcome: Outcome;
  project: string | null;        // guard columns: stored for later lift, not read by v1 score
  agent: string | null;
  model: string | null;
  missionHint: string | null;
  atMs: number;
}

/** Join fired artifacts to their session's outcome. Two guards:
 *   - a session with no facet is skipped (never a null outcome);
 *   - a facet with origin !== "llm" is skipped — deterministicFacets emits a
 *     placeholder "partially_achieved" with origin "heuristic" when the judge
 *     degrades, and persisting those would pollute every score with non-judgments.
 *  One row per (session, artifact). */
export function buildArtifactOutcomeRows(
  signal: WorkflowSignal,
  facets: SessionFacet[],
  ctx: { project: string | null; agent: string | null },
): ArtifactOutcomeRow[] {
  const facetById = new Map(
    facets.filter((f) => f.origin === "llm").map((f) => [f.sessionId, f]),
  );
  const rows: ArtifactOutcomeRow[] = [];
  for (const s of signal.sequences?.sessions ?? []) {
    const facet = facetById.get(s.sessionId);
    if (!facet) continue;
    const seen = new Set<string>();
    for (const ev of s.eventSeries ?? []) {
      const key = `${ev.kind}:${ev.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        sessionId: s.sessionId,
        artifactType: ev.kind,
        artifactName: ev.name,
        outcome: facet.outcome,
        project: ctx.project,
        agent: ctx.agent,
        model: facet.model ?? null,
        missionHint: s.missionHint?.task ?? null,
        atMs: facet.atMs,
      });
    }
  }
  return rows;
}
