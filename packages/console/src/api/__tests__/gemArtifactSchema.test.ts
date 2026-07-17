// packages/console/src/api/__tests__/gemArtifactSchema.test.ts
// The client parse STRIPS undeclared keys (plain z.object, not passthrough), so a
// skill artifact's description/content must be DECLARED in the client GemSchema or
// the Mine "Distill → Gem" viewer silently renders nothing. Key-set assertion —
// a bare .success check is one-directional and stays green while Zod strips.
import { describe, it, expect } from "vitest";
import { GemSchema } from "../routes.js";

describe("client GemSchema", () => {
  it("keeps a skill artifact's description and content through the parse", () => {
    const artifact = { type: "skill", name: "deploy", description: "ship it", content: "# SKILL" };
    const gem = { name: "g", createdFrom: "/x", artifacts: [artifact], checks: [], requiredSecrets: [] };
    const parsed = GemSchema.parse(gem);
    expect(Object.keys(parsed.artifacts[0]).sort()).toEqual(Object.keys(artifact).sort());
  });
});
