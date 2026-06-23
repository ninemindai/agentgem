// src/publish.ts
// Network publish: render a Gem, register each skill as a custom Agent Skill (Skills API), then
// create the agent referencing those skills. The PublishClient is injected so the orchestration is
// unit-tested without a key or network. Only confirmed SDK bindings are used.
import Anthropic, { toFile } from "@anthropic-ai/sdk";
import { renderManagedAgent } from "./gem/publish.js";
import type { ManagedAgentPayload, SkippedArtifact } from "./gem/publish.js";
import type { Gem, SecretRequirement } from "./gem/types.js";
import type { DeployRecord } from "./gem/deployRecord.js";

export interface RegisteredSkill { name: string; skillId: string; version: string }

export interface PublishResult {
  agentId: string;
  environmentId: string;
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
  deleteSkill(skillId: string): Promise<void>;
  createEnvironment(name: string): Promise<{ id: string }>;
  deleteEnvironment(environmentId: string): Promise<void>;
  createAgent(payload: ManagedAgentPayload & { skills: CustomSkillRef[] }): Promise<{ id: string; version: string }>;
  deleteAgent?(agentId: string): Promise<void>;
}

const PUBLISH_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const publishRequests = new Map<string, { fingerprint: string; expiresAt: number; promise: Promise<PublishResult> }>();

export function publishManagedAgentOnce(
  requestId: string,
  fingerprint: string,
  publish: () => Promise<PublishResult>,
): Promise<PublishResult> {
  const now = Date.now();
  for (const [id, entry] of publishRequests) if (entry.expiresAt <= now) publishRequests.delete(id);
  const existing = publishRequests.get(requestId);
  if (existing) {
    if (existing.fingerprint !== fingerprint) return Promise.reject(new Error("publish requestId was reused with a different payload"));
    return existing.promise;
  }
  const promise = publish().catch((error) => {
    publishRequests.delete(requestId);
    throw error;
  });
  publishRequests.set(requestId, { fingerprint, expiresAt: now + PUBLISH_CACHE_TTL_MS, promise });
  const timer = setTimeout(() => {
    if (publishRequests.get(requestId)?.promise === promise) publishRequests.delete(requestId);
  }, PUBLISH_CACHE_TTL_MS);
  timer.unref();
  return promise;
}

export async function publishManagedAgent(gem: Gem, client: PublishClient): Promise<PublishResult> {
  const render = renderManagedAgent(gem);
  const registeredSkills: RegisteredSkill[] = [];
  let environmentId: string | undefined;
  try {
    for (const s of render.skillsToRegister) {
      const { skillId, version } = await client.createSkill(s.name, s.content);
      registeredSkills.push({ name: s.name, skillId, version });
    }
    environmentId = (await client.createEnvironment(`${gem.name} sandbox`)).id;
    const skills: CustomSkillRef[] = registeredSkills.map((r) => ({ type: "custom", skill_id: r.skillId, version: r.version }));
    const agent = await client.createAgent({ ...render.payload, skills });
    return { agentId: agent.id, environmentId, version: agent.version, registeredSkills, skipped: render.skipped, vaultSecrets: render.vaultSecrets };
  } catch (error) {
    const cleanupErrors: Error[] = [];
    if (environmentId) {
      try { await client.deleteEnvironment(environmentId); }
      catch (cleanupError) { cleanupErrors.push(new Error(`failed to delete environment ${environmentId}`, { cause: cleanupError })); }
    }
    const skillCleanup = await Promise.allSettled(registeredSkills.map((s) => client.deleteSkill(s.skillId)));
    skillCleanup.forEach((result, index) => {
      if (result.status === "rejected") cleanupErrors.push(new Error(`failed to delete skill ${registeredSkills[index].skillId}`, { cause: result.reason }));
    });
    if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], "publish failed and rollback was incomplete");
    throw error;
  }
}

// Tear down a managed-agent deploy: delete the agent, its environment, then each registered skill.
// Each delete is independent — a failure in one does NOT abort the others (so an already-gone
// resource doesn't strand the rest) — but real failures are collected and rethrown so the caller
// (and the user) learns the teardown was partial. Mirrors publishManagedAgent's rollback contract.
export async function undeployManagedAgent(rec: DeployRecord, client: PublishClient): Promise<void> {
  const errors: Error[] = [];
  const attempt = async (what: string, fn: () => Promise<void>) => {
    try { await fn(); } catch (cause) { errors.push(new Error(`failed to delete ${what}`, { cause })); }
  };
  if (rec.agentId) await attempt(`agent ${rec.agentId}`, async () => {
    if (!client.deleteAgent) throw new Error("client does not support deleting agents");
    await client.deleteAgent(rec.agentId!);
  });
  if (rec.environmentId) await attempt(`environment ${rec.environmentId}`, () => client.deleteEnvironment(rec.environmentId!));
  for (const sid of rec.skillIds ?? []) await attempt(`skill ${sid}`, () => client.deleteSkill(sid));
  if (errors.length) throw new AggregateError(errors, `undeploy completed with ${errors.length} failure(s)`);
}

const safeUploadDirectory = (name: string): string => {
  const safe = name.normalize("NFKC").replace(/[^A-Za-z0-9._-]/g, "_");
  return safe === "." || safe === ".." || safe.length === 0 ? "skill" : safe;
};

// Real client. skills.create uploads a single SKILL.md under a top-level dir named for the skill;
// the API extracts name/description from it and returns the skill id + latest_version. The SDK sets
// the skills-2025-10-02 / managed-agents-2026-04-01 beta headers automatically.
export function anthropicPublishClient(apiKey: string): PublishClient {
  const client = new Anthropic({ apiKey });
  return {
    async createSkill(name, skillMd) {
      const file = await toFile(Buffer.from(skillMd), `${safeUploadDirectory(name)}/SKILL.md`);
      const created = await client.beta.skills.create({ display_title: name, files: [file] });
      return { skillId: created.id, version: created.latest_version ?? "latest" };
    },
    async deleteSkill(skillId) { await client.beta.skills.delete(skillId); },
    async createEnvironment(name) {
      const environment = await client.beta.environments.create({
        name,
        description: "Managed sandbox created by agentgem",
        config: { type: "cloud", networking: { type: "limited", allow_mcp_servers: true, allow_package_managers: false, allowed_hosts: [] } },
      });
      return { id: environment.id };
    },
    async deleteEnvironment(environmentId) { await client.beta.environments.delete(environmentId); },
    async createAgent(payload) {
      const agent = await client.beta.agents.create(payload as unknown as Parameters<typeof client.beta.agents.create>[0]);
      return { id: agent.id, version: String((agent as { version?: unknown }).version ?? "") };
    },
    // NOTE: @anthropic-ai/sdk does not expose client.beta.agents.delete() as of this writing.
    // The agents resource only has create/retrieve/update/list/archive. We fall back to the
    // low-level client.delete() which sends a raw DELETE to /v1/agents/{id} with the required
    // managed-agents-2026-04-01 beta header.
    async deleteAgent(agentId) {
      await (client as unknown as { delete(path: string, opts?: unknown): Promise<unknown> }).delete(
        `/v1/agents/${agentId}`,
        { headers: { "anthropic-beta": "managed-agents-2026-04-01" } },
      );
    },
  };
}
