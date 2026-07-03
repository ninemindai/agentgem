// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// A view over a GemVerificationReport — no persistence. Surfaces trigger precision,
// collisions, and context budget for the console scorecard (Plan 2) and grade input.
import type { Gem, GemVerificationReport } from "@agentgem/model";

export interface TriggerScorecard {
  precision: number | null; // route-confusion CheckResult.score, null if not run
  collisions: string[];     // finding titles from that result
  contextBudgetChars: number;
}

export function triggerScorecard(report: GemVerificationReport, gem: Gem): TriggerScorecard {
  const rc = report.results.find((r) => r.runner === "route-confusion");
  const contextBudgetChars = gem.artifacts
    .filter((a): a is Extract<typeof a, { type: "skill" }> => a.type === "skill")
    .reduce((n, s) => n + s.content.length + (s.trigger ? JSON.stringify(s.trigger).length : 0), 0);
  return {
    precision: rc?.score ?? null,
    collisions: (rc?.findings ?? []).map((f) => f.title),
    contextBudgetChars,
  };
}
