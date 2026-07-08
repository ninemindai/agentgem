import { describe, it, expect } from "vitest";
import type { Gem, LoopSpec } from "@agentgem/model";

const loop: LoopSpec = {
  mode: "loop",
  schedule: { kind: "interval", everyMs: 3_600_000 },
  guardrails: { approval: "gate", maxRounds: 1 },
};

describe("LoopSpec type", () => {
  it("attaches to a Gem as an optional facet", () => {
    const gem: Gem = {
      name: "inbox-triage",
      createdFrom: "test",
      artifacts: [{ type: "skill", name: "triage", source: "standalone", content: "# Triage" }],
      checks: [],
      requiredSecrets: [],
      loop,
    };
    expect(gem.loop?.mode).toBe("loop");
    expect(gem.loop?.guardrails.approval).toBe("gate");
  });
});
