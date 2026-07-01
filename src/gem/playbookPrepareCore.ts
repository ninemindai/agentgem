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
  for (const s of skills) deps.persistSkill(s);
  for (const l of lessons) deps.persistLesson(l);
  return { skills: skills.map((s) => s.name), lessons: lessons.map((l) => l.name), root: deps.root, degraded };
}
