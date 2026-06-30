// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/playbookDraft.ts
// Assemble a Playbook Gem from distilled wins (skills) + lessons (instructions).
// Staging makes distilled drafts visible to buildGem; the resulting gem carries a
// skill with source "distilled-draft" so GemTypeRegistry derives the playbook cut.
import type { ConfigInventory, Gem } from "@agentgem/model";
import { stageDraftsByEvidence, stageLessonsByEvidence } from "@agentgem/capture";
import { buildGem } from "@agentgem/build";
import type { GemSelection } from "@agentgem/build";
import type { DistilledSkill, DistilledLesson } from "@agentgem/insight";

// The concrete (non-all) selection variant returned by buildPlaybookGem. Using the
// Exclude utility avoids inventing a new type while still giving callers typed
// access to `.skills`, `.includeInstructions`, etc. without a union narrowing step.
export type PlaybookSelection = Exclude<GemSelection, { all: true }>;

export function buildPlaybookGem(args: {
  name: string; baseInventory: ConfigInventory; skills: DistilledSkill[]; lessons: DistilledLesson[]; createdFrom?: string;
}): { gem: Gem; selection: PlaybookSelection } {
  const staged = stageLessonsByEvidence(stageDraftsByEvidence(args.baseInventory, args.skills), args.lessons);
  const selection: PlaybookSelection = {
    skills: args.skills.map((s) => s.name),
    includeInstructions: args.lessons.length > 0,
  };
  const gem = buildGem(staged, selection, { name: args.name, createdFrom: args.createdFrom ?? "claude" });
  return { gem, selection };
}
