// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/contextCap.ts
//
// Context-window size for a model id. The "pinned" hygiene signal is a fraction
// of this cap, so the number lives in one place — never hardcoded in a detector.
// Two ways a model gets the 1M window: the opt-in marker (`[1m]` or `-1m` in the
// id, the pre-4.6 beta convention) or membership in a family whose window is 1M
// BY DEFAULT (Claude 4.6+ generation). Everything else uses the conservative
// 200k default — a real Fable session's prompt exceeds 200k on turn one, so a
// missing family entry reads as "pinned at the cap" from the very first turn.

const ONE_MILLION = 1_000_000;
const DEFAULT_CAP = 200_000;

// Substring match (not equality) so date-suffixed ids ("claude-opus-4-6-20260115")
// and provider-prefixed ids ("anthropic.claude-fable-5") resolve the same family.
const MILLION_DEFAULT_FAMILIES = [
  "claude-fable",
  "claude-mythos",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-sonnet-5",
];

export function contextCap(model?: string): number {
  if (!model) return DEFAULT_CAP;
  if (/\[1m\]/i.test(model) || /-1m\b/i.test(model)) return ONE_MILLION;
  const id = model.toLowerCase();
  if (MILLION_DEFAULT_FAMILIES.some((family) => id.includes(family))) return ONE_MILLION;
  return DEFAULT_CAP;
}
