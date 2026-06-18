// src/publish.ts
// Network publish: render a Pack, register each skill as a custom Agent Skill (Skills API), then
// create the agent referencing those skills. The PublishClient is injected so the orchestration is
// unit-tested without a key or network. Only confirmed SDK bindings are used.
import Anthropic, { toFile } from "@anthropic-ai/sdk";
import { renderManagedAgent } from "./pack/publish.js";
import type { ManagedAgentPayload, SkippedArtifact } from "./pack/publish.js";
import type { Pack, SecretRequirement } from "./pack/types.js";

export interface RegisteredSkill { name: string; skillId: string; version: string }

export interface PublishResult {
  agentId: string;
  version: string;
  registeredSkills: RegisteredSkill[];
  skipped: SkippedArtifact[];
  vaultSecrets: SecretRequirement[];
}

// Custom-skill reference attached to the agent.
export type CustomSkillRef = { type: "custom"; skill_id: string; version: string };

// Injected for testing. createSkill registers one skill (-> id + version); createAgent creates the
// agent with the rendered payload + the resolved skill refs.
export interface PublishClient {
  createSkill(name: string, skillMd: string): Promise<{ skillId: string; version: string }>;
  createAgent(payload: ManagedAgentPayload & { skills: CustomSkillRef[] }): Promise<{ id: string; version: string }>;
}

export async function publishManagedAgent(pack: Pack, client: PublishClient): Promise<PublishResult> {
  const render = renderManagedAgent(pack);
  const registeredSkills: RegisteredSkill[] = [];
  for (const s of render.skillsToRegister) {
    const { skillId, version } = await client.createSkill(s.name, s.content);
    registeredSkills.push({ name: s.name, skillId, version });
  }
  const skills: CustomSkillRef[] = registeredSkills.map((r) => ({ type: "custom", skill_id: r.skillId, version: r.version }));
  const agent = await client.createAgent({ ...render.payload, skills });
  return { agentId: agent.id, version: agent.version, registeredSkills, skipped: render.skipped, vaultSecrets: render.vaultSecrets };
}

// Real client. skills.create uploads a single SKILL.md under a top-level dir named for the skill;
// the API extracts name/description from it and returns the skill id + latest_version. The SDK sets
// the skills-2025-10-02 / managed-agents-2026-04-01 beta headers automatically.
export function anthropicPublishClient(apiKey: string): PublishClient {
  const client = new Anthropic({ apiKey });
  return {
    async createSkill(name, skillMd) {
      const file = await toFile(Buffer.from(skillMd), `${name}/SKILL.md`);
      const created = await client.beta.skills.create({ display_title: name, files: [file] });
      return { skillId: created.id, version: created.latest_version ?? "latest" };
    },
    async createAgent(payload) {
      const agent = await client.beta.agents.create(payload as unknown as Parameters<typeof client.beta.agents.create>[0]);
      return { id: agent.id, version: String((agent as { version?: unknown }).version ?? "") };
    },
  };
}
