// src/publish.ts
// Network publish: render a Pack into the Managed Agents payload, then create the agent via the
// Anthropic API. The agent-creator is injected so the orchestration is unit-tested without a key
// or a network call. Only confirmed bindings are used (client.beta.agents.create); custom-skill
// registration via the Skills API is a follow-up (skills are inlined into `system` for now).
import Anthropic from "@anthropic-ai/sdk";
import { renderManagedAgent } from "./pack/publish.js";
import type { ManagedAgentPayload, SkippedArtifact } from "./pack/publish.js";
import type { Pack, SecretRequirement } from "./pack/types.js";

export interface PublishResult {
  agentId: string;
  version: string;
  inlinedSkills: string[];
  skipped: SkippedArtifact[];
  vaultSecrets: SecretRequirement[];
}

// A function that creates a Managed Agent and returns its id + version. Injected for testing.
export type AgentCreator = (payload: ManagedAgentPayload) => Promise<{ id: string; version: string }>;

export async function publishManagedAgent(pack: Pack, createAgent: AgentCreator): Promise<PublishResult> {
  const render = renderManagedAgent(pack);
  const agent = await createAgent(render.payload);
  return {
    agentId: agent.id,
    version: agent.version,
    inlinedSkills: render.inlinedSkills,
    skipped: render.skipped,
    vaultSecrets: render.vaultSecrets,
  };
}

// Real creator: client.beta.agents.create(payload) -> BetaManagedAgentsAgent { id, version }.
// (The SDK sets the managed-agents beta header automatically.)
export function anthropicAgentCreator(apiKey: string): AgentCreator {
  const client = new Anthropic({ apiKey });
  return async (payload) => {
    const agent = await client.beta.agents.create(payload as unknown as Parameters<typeof client.beta.agents.create>[0]);
    return { id: agent.id, version: String((agent as { version?: unknown }).version ?? "") };
  };
}
