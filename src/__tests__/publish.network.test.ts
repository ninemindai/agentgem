// src/__tests__/publish.network.test.ts
import { describe, it, expect } from "vitest";
import { publishManagedAgent } from "../publish.js";
import type { PublishClient, CustomSkillRef } from "../publish.js";
import type { ManagedAgentPayload } from "../pack/publish.js";
import type { Pack } from "../pack/types.js";

const pack: Pack = {
  name: "p", createdFrom: "/d", checks: [], requiredSecrets: [],
  artifacts: [
    { type: "skill", name: "review", source: "standalone", content: "# Review body" },
    { type: "skill", name: "deploy", source: "standalone", content: "# Deploy body" },
    { type: "instructions", name: "CLAUDE.md", content: "be careful" },
    { type: "mcp_server", name: "gh", transport: "http", source: "user", config: { url: "https://x/mcp" } },
  ],
};

describe("publishManagedAgent (injected client)", () => {
  it("registers each skill, then creates the agent referencing them by skill_id", async () => {
    const created: { name: string; content: string }[] = [];
    let agentPayload: (ManagedAgentPayload & { skills: CustomSkillRef[] }) | undefined;
    const client: PublishClient = {
      async createSkill(name, content) { created.push({ name, content }); return { skillId: `skill_${name}`, version: "v1" }; },
      async createAgent(payload) { agentPayload = payload; return { id: "agent_1", version: "1" }; },
    };
    const result = await publishManagedAgent(pack, client);

    // each skill was registered with its SKILL.md body
    expect(created.map((c) => c.name)).toEqual(["review", "deploy"]);
    expect(created[0].content).toContain("# Review body");
    // the agent payload references the registered skills as custom skill refs
    expect(agentPayload?.skills).toEqual([
      { type: "custom", skill_id: "skill_review", version: "v1" },
      { type: "custom", skill_id: "skill_deploy", version: "v1" },
    ]);
    // skills are NOT inlined into the system prompt anymore
    expect(agentPayload?.system).not.toContain("# Review body");
    expect(agentPayload?.mcp_servers).toEqual([{ type: "url", name: "gh", url: "https://x/mcp" }]);
    // result surfaces created agent + registered skills
    expect(result.agentId).toBe("agent_1");
    expect(result.registeredSkills).toEqual([
      { name: "review", skillId: "skill_review", version: "v1" },
      { name: "deploy", skillId: "skill_deploy", version: "v1" },
    ]);
  });

  it("propagates a Skills-API failure (does not swallow it)", async () => {
    const client: PublishClient = {
      async createSkill() { throw new Error("400 skill upload rejected"); },
      async createAgent() { return { id: "x", version: "1" }; },
    };
    await expect(publishManagedAgent(pack, client)).rejects.toThrow(/skill upload rejected/);
  });
});
