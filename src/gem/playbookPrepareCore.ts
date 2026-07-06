// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/playbookPrepareCore.ts
import type { DistilledSkill, DistilledLesson } from "@agentgem/insight";

export interface PreparePlaybookDeps {
  root: string;
  distill: () => Promise<{ skills: DistilledSkill[]; lessons: DistilledLesson[]; degraded: boolean }>;
  persistSkill: (s: DistilledSkill) => void;
  persistLesson: (l: DistilledLesson) => void;
}

export async function preparePlaybook(deps: PreparePlaybookDeps): Promise<{ skills: string[]; lessons: string[]; root: string; degraded: boolean }> {
  const { skills, lessons, degraded } = await deps.distill();
  // Only publish + persist GENUINELY-distilled skills (origin "llm"). Heuristic
  // SKELETONS — the degrade fallback when the agent times out/fails — are low-quality
  // throwaway: publishing them ships junk to the public catalog, and persisting them
  // as drafts pollutes ~/.agentgem/distilled and poisons the next distill's dedup.
  // (Share-my-setup and manual curation/composition don't go through this path, so
  // they still publish exactly what the user selected.) An all-skeleton result yields
  // no skills → Curate shows its "nothing distilled worth publishing yet" empty state.
  const distilled = skills.filter((s) => s.origin === "llm");
  for (const s of distilled) deps.persistSkill(s);
  for (const l of lessons) deps.persistLesson(l);
  return { skills: distilled.map((s) => s.name), lessons: lessons.map((l) => l.name), root: deps.root, degraded };
}
