// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Pure route-confusion scorer. The platform-runner adapter supplies a real LLM/embedding
// judge; tests supply a fake one. No I/O, no LLM here — deterministic and offline.
import type { TriggerContract } from "@agentgem/model";

export type Candidate = { name: string; contract: TriggerContract };
export type RouteJudge = (phrase: string, candidates: Candidate[]) => string;

export interface RouteConfusionResult {
  score: number; // trigger precision − collision rate, clamped 0..1
  findings: { severity: string; title: string; detail?: string }[];
}

export function scoreRouteConfusion(own: Candidate, corpus: Candidate[], judge: RouteJudge): RouteConfusionResult {
  const candidates = [own, ...corpus];
  const findings: RouteConfusionResult["findings"] = [];

  const triggers = own.contract.triggers;
  let correct = 0;
  for (const t of triggers) {
    const routed = judge(t, candidates);
    if (routed === own.name) correct++;
    else findings.push({ severity: "warn", title: `trigger mis-routes: "${t}"`, detail: `routed to "${routed}"` });
  }
  const precision = triggers.length ? correct / triggers.length : 1;

  const anti = own.contract.antiTriggers;
  let collisions = 0;
  for (const a of anti) {
    if (judge(a, candidates) === own.name) {
      collisions++;
      findings.push({ severity: "warn", title: `anti-trigger wrongly fires: "${a}"` });
    }
  }
  const collisionRate = anti.length ? collisions / anti.length : 0;

  const score = Math.min(1, Math.max(0, precision - collisionRate));
  return { score, findings };
}
