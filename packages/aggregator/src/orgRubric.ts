// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Per-gem maturity rubric — the Cortex/Backstage-Soundcheck "scorecard" surface. v1 reads ONLY
// fields already on a catalog_gems row plus computed engagement (stars/installs), so it needs no
// new data pipeline. Deeper checks (cross-agent verified, has-evals) are a deferred fast-follow —
// see docs/superpowers/specs/2026-07-03-org-scorecard-catalog-design.md §8 D2.
export interface RubricInput {
  description: string | null;
  tags: string[] | null;
  artifactKinds: string[] | null;
  grade: number | null;
  publishedBy: string | null;
  stars: number;
  installs: number;
}
export interface RubricCheck { id: string; label: string; pass: boolean; howToFix: string }
export interface RubricResult { score: number; checks: RubricCheck[] }

interface RubricDef { id: string; label: string; howToFix: string; test: (i: RubricInput) => boolean }

export const ORG_RUBRIC: RubricDef[] = [
  { id: "documented", label: "Documented", howToFix: "Add a description and at least one tag before publishing.",
    test: (i) => !!i.description?.trim() && (i.tags?.length ?? 0) >= 1 },
  { id: "substance", label: "Has substance", howToFix: "Publish at least one artifact (skill, mcp_server, …).",
    test: (i) => (i.artifactKinds?.length ?? 0) >= 1 },
  { id: "battleTested", label: "Battle-tested", howToFix: "Distill from real, battle-tested sessions to raise the grade.",
    test: (i) => (i.grade ?? 0) >= 2 },
  { id: "adopted", label: "Adopted", howToFix: "Share the gem so others star or install it.",
    test: (i) => i.stars >= 1 || i.installs >= 1 },
  { id: "attributed", label: "Attributed", howToFix: "Publish under a verified account.",
    test: (i) => !!i.publishedBy?.trim() },
];

export function computeGemRubric(input: RubricInput): RubricResult {
  const checks: RubricCheck[] = ORG_RUBRIC.map((d) => ({ id: d.id, label: d.label, howToFix: d.howToFix, pass: d.test(input) }));
  const passing = checks.filter((c) => c.pass).length;
  return { score: checks.length ? passing / checks.length : 0, checks };
}
