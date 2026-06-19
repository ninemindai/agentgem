// src/gem/checks.ts
// Scaffold editable check drafts from a built Gem. Pure; runs nothing. The runner registry
// holds DECLARATIONS only — the adapters that actually execute live in the platform runner.
import type { Gem, GemArtifact, GemCheck } from "./types.js";

export const RUNNER_REGISTRY = {
  skillspector: {
    id: "skillspector",
    consumes: "pack-as-directory", // Gem materializes to a dir of SKILL.md + config
    resultShape: "score+findings",
    defaultWith: { failAboveRisk: 40 },
  },
} as const;

export function scaffoldChecks(pack: Gem): GemCheck[] {
  const skills = pack.artifacts.filter((a): a is Extract<GemArtifact, { type: "skill" }> => a.type === "skill");
  const lead = skills[0];
  const intent = lead?.description ?? lead?.name ?? "the bundled capability";

  const checks: GemCheck[] = [
    {
      kind: "behavioral",
      name: "smoke",
      description: "Draft — edit the task and add assertions before relying on this check.",
      task: `Using this pack, ${intent}. Then report what you did.`,
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
