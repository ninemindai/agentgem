// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// goldmine context assembler: builds the pre-inject brief grounding a chat agent in the user's local session history

export interface GoldmineBriefInput {
  scorecard: { breadth: number; battleTested: number; portable: number; gaps: string[] };
  topArtifacts: { type: string; name: string; invocations: number }[];
  skillCount: number;
  behavior?: { patterns: number; topTitle: string };
}

export function buildGoldmineBrief(input: GoldmineBriefInput): string {
  const { scorecard: s, topArtifacts, skillCount, behavior } = input;
  const lines = [
    `You are grounded in the user's local "goldmine" of coding sessions and installed artifacts. Use it to answer questions and, when asked, help distill a reusable Gem. You have read tools (search_sessions, get_artifact_detail, get_behavior_findings) — call them for detail beyond this summary.`,
    ``,
    `GOLDMINE SUMMARY (facts):`,
    `- Scorecard: breadth ${s.breadth}, battle-tested ${s.battleTested}, portable ${s.portable}.`,
    `- Installed skills: ${skillCount}.`,
    topArtifacts.length ? `- Most-used artifacts: ${topArtifacts.map((a) => `${a.name} (${a.type}, ${a.invocations}×)`).join(", ")}.` : `- No artifact usage recorded yet.`,
    s.gaps.length ? `- Gaps (used but not installed): ${s.gaps.join(", ")}.` : `- No gaps detected.`,
    ...(behavior
      ? [`- Behavior: ${behavior.patterns} recurring pattern(s) detected in recent sessions — top: "${behavior.topTitle}". The user can ask you for coaching on these; call get_behavior_findings for detail.`]
      : []),
  ];
  return lines.join("\n");
}
