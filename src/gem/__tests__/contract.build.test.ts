// src/gem/__tests__/contract.build.test.ts
import { describe, it, expect } from "vitest";
import { buildGem } from "@agentgem/build";
import type { ConfigInventory, GemContract } from "@agentgem/model";

const inv: ConfigInventory = {
  skills: [{ type: "skill", name: "demo-skill", source: "standalone", content: "# demo" }],
  mcpServers: [],
  instructions: [{ type: "instructions", name: "CLAUDE.md", content: "notes" }],
  hooks: [],
  subagents: [],
};

describe("buildGem contract derivation", () => {
  it("derives a conservative contract when the gem bundles a skill", () => {
    const gem = buildGem(inv, { skills: ["demo-skill"] }, { name: "g" });
    expect(gem.contract).toBeDefined();
    expect(gem.contract!.task).toContain('"demo-skill"');
    expect(gem.contract!.expect.tools).toEqual(["demo-skill"]);
    expect(gem.contract!.expect.forbidToolFailures).toBe(true);
  });

  it("derives no contract for a gem without skills", () => {
    const gem = buildGem(inv, { includeInstructions: true }, { name: "g" });
    expect(gem.contract).toBeUndefined();
  });

  it("an explicit opts.contract wins over derivation", () => {
    const explicit: GemContract = { task: "custom task", expect: { text: "ok" } };
    const gem = buildGem(inv, { skills: ["demo-skill"] }, { name: "g", contract: explicit });
    expect(gem.contract).toEqual(explicit);
  });
});
