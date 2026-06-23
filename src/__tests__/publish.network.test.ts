// src/__tests__/publish.network.test.ts
import { describe, it, expect } from "vitest";
import { publishManagedAgent, publishManagedAgentOnce, undeployManagedAgent } from "../publish.js";
import type { PublishClient, CustomSkillRef } from "../publish.js";
import type { ManagedAgentPayload } from "../gem/publish.js";
import type { Gem } from "../gem/types.js";

const gem: Gem = {
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
      async deleteSkill() {},
      async createEnvironment() { return { id: "env_1" }; },
      async deleteEnvironment() {},
      async createAgent(payload) { agentPayload = payload; return { id: "agent_1", version: "1" }; },
    };
    const result = await publishManagedAgent(gem, client);

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
    expect(result.environmentId).toBe("env_1");
    expect(result.registeredSkills).toEqual([
      { name: "review", skillId: "skill_review", version: "v1" },
      { name: "deploy", skillId: "skill_deploy", version: "v1" },
    ]);
  });

  it("propagates a Skills-API failure (does not swallow it)", async () => {
    const client: PublishClient = {
      async createSkill() { throw new Error("400 skill upload rejected"); },
      async deleteSkill() {},
      async createEnvironment() { return { id: "env_1" }; },
      async deleteEnvironment() {},
      async createAgent() { return { id: "x", version: "1" }; },
    };
    await expect(publishManagedAgent(gem, client)).rejects.toThrow(/skill upload rejected/);
  });

  it("rolls back created skills and the sandbox when agent creation fails", async () => {
    const deletedSkills: string[] = [];
    const deletedEnvironments: string[] = [];
    const client: PublishClient = {
      async createSkill(name) { return { skillId: `skill_${name}`, version: "v1" }; },
      async deleteSkill(id) { deletedSkills.push(id); },
      async createEnvironment() { return { id: "env_rollback" }; },
      async deleteEnvironment(id) { deletedEnvironments.push(id); },
      async createAgent() { throw new Error("agent rejected"); },
    };
    await expect(publishManagedAgent(gem, client)).rejects.toThrow(/agent rejected/);
    expect(deletedSkills.sort()).toEqual(["skill_deploy", "skill_review"]);
    expect(deletedEnvironments).toEqual(["env_rollback"]);
  });

  it("surfaces orphaned resource IDs when rollback itself fails", async () => {
    const client: PublishClient = {
      async createSkill(name) { return { skillId: `skill_${name}`, version: "v1" }; },
      async deleteSkill(id) { if (id === "skill_review") throw new Error("delete denied"); },
      async createEnvironment() { return { id: "env_orphan" }; },
      async deleteEnvironment() { throw new Error("delete denied"); },
      async createAgent() { throw new Error("agent rejected"); },
    };
    await expect(publishManagedAgent(gem, client)).rejects.toThrow(/rollback was incomplete/);
    try { await publishManagedAgent(gem, client); }
    catch (error) {
      const messages = (error as AggregateError).errors.map((e: Error) => e.message);
      expect(messages).toContain("failed to delete environment env_orphan");
      expect(messages).toContain("failed to delete skill skill_review");
    }
  });

  it("undeployManagedAgent deletes agent, environment, and skills", async () => {
    const deleted: string[] = [];
    const client = {
      deleteAgent: async (id: string) => { deleted.push("agent:" + id); },
      deleteEnvironment: async (id: string) => { deleted.push("env:" + id); },
      deleteSkill: async (id: string) => { deleted.push("skill:" + id); },
    } as unknown as PublishClient;
    await undeployManagedAgent({ backend: "claude-managed", agentId: "a1", environmentId: "e1", skillIds: ["s1", "s2"] }, client);
    expect(deleted).toContain("agent:a1");
    expect(deleted).toContain("env:e1");
    expect(deleted).toEqual(expect.arrayContaining(["skill:s1", "skill:s2"]));
  });

  it("deduplicates concurrent and retried publish requests by requestId", async () => {
    let calls = 0;
    const run = async () => {
      calls += 1;
      return {
        agentId: "agent_once", environmentId: "env_once", version: "1",
        registeredSkills: [], skipped: [], vaultSecrets: [],
      };
    };
    const [a, b] = await Promise.all([
      publishManagedAgentOnce("request-123", "same", run),
      publishManagedAgentOnce("request-123", "same", run),
    ]);
    expect(a).toEqual(b);
    expect(calls).toBe(1);
    await expect(publishManagedAgentOnce("request-123", "different", run)).rejects.toThrow(/different payload/);
  });
});
