// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/checks.ts
// Scaffold editable check drafts from a built Gem. Pure; runs nothing. The runner registry
// holds DECLARATIONS only — the adapters that actually execute live in the platform runner.
import type { Gem, GemArtifact, GemCheck } from "@agentgem/model";

export const RUNNER_REGISTRY = {
  skillspector: {
    id: "skillspector",
    consumes: "gem-as-directory", // Gem materializes to a dir of SKILL.md + config
    resultShape: "score+findings",
    defaultWith: { failAboveRisk: 40 },
  },
} as const;

export function scaffoldChecks(gem: Gem): GemCheck[] {
  const skills = gem.artifacts.filter((a): a is Extract<GemArtifact, { type: "skill" }> => a.type === "skill");
  const lead = skills[0];
  const intent = lead?.description ?? lead?.name ?? "the bundled capability";

  const checks: GemCheck[] = [
    {
      kind: "behavioral",
      name: "smoke",
      description: "Draft — edit the task and add assertions before relying on this check.",
      task: `Using this gem, ${intent}. Then report what you did.`,
      assertions: [], // stubs: meaningful deterministic assertions are operator-authored
      timeoutSec: 300,
    },
  ];

  if (skills.length) {
    const reg = RUNNER_REGISTRY.skillspector;
    checks.push({ kind: "external", name: "security-scan", runner: reg.id, with: { ...reg.defaultWith } });
  }

  return checks;
}
