// src/__tests__/publish.network.test.ts
import { describe, it, expect } from "vitest";
import { publishManagedAgent } from "../publish.js";
import type { ManagedAgentPayload } from "../pack/publish.js";
import type { Pack } from "../pack/types.js";

const pack: Pack = {
  name: "p", createdFrom: "/d", checks: [], requiredSecrets: [],
  artifacts: [
    { type: "skill", name: "review", source: "standalone", content: "body" },
    { type: "instructions", name: "CLAUDE.md", content: "be careful" },
    { type: "mcp_server", name: "gh", transport: "http", source: "user", config: { url: "https://x/mcp" } },
  ],
};

describe("publishManagedAgent (injected creator)", () => {
  it("creates the agent with the rendered payload and returns id/version + lists", async () => {
    let seen: ManagedAgentPayload | undefined;
    const result = await publishManagedAgent(pack, async (payload) => {
      seen = payload;
      return { id: "agent_123", version: "1" };
    });
    // the creator receives exactly the rendered agents.create payload
    expect(seen?.name).toBe("p");
    expect(seen?.model).toBe("claude-opus-4-8");
    expect(seen?.system).toContain("# Skill: review");
    expect(seen?.mcp_servers).toEqual([{ type: "url", name: "gh", url: "https://x/mcp" }]);
    // result surfaces the created agent + render side-lists
    expect(result.agentId).toBe("agent_123");
    expect(result.version).toBe("1");
    expect(result.inlinedSkills).toEqual(["review"]);
  });

  it("propagates a creator failure (API error) rather than swallowing it", async () => {
    await expect(
      publishManagedAgent(pack, async () => { throw new Error("401 unauthorized"); }),
    ).rejects.toThrow(/401/);
  });
});
