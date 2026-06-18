// src/pack/publish.ts
// Pure render: a (redacted) Pack -> a Claude Managed Agents `agents.create` payload plus the
// side-lists the operator needs. No network and no secret values — it maps the already-redacted
// Pack. The network publish (skills.create -> agents.create) lives in src/publish.ts.
import type {
  Pack, ArtifactType, SecretRequirement,
  SkillArtifact, McpServerArtifact, InstructionsArtifact, HookArtifact,
} from "./types.js";

export const MANAGED_AGENTS_MODEL = "claude-opus-4-8";
const MAX_SKILLS = 20; // Managed Agents caps skills + mcp_servers at 20 each
const MAX_MCP = 20;

export interface ManagedAgentPayload {
  name: string;
  model: string;
  system: string;
  mcp_servers: { type: "url"; name: string; url: string }[];
  skills: { name: string }[]; // names only here — skill_id is assigned at publish after Skills API create
  tools: ({ type: "agent_toolset_20260401" } | { type: "mcp_toolset"; mcp_server_name: string })[];
}

export interface SkippedArtifact { artifact: string; type: ArtifactType; reason: string }

export interface ManagedAgentRender {
  payload: ManagedAgentPayload;
  skillBodies: { name: string; content: string }[]; // each created via the Skills API at publish
  skipped: SkippedArtifact[];
  vaultSecrets: SecretRequirement[]; // names only — operator adds these to a vault post-publish
}

export function renderManagedAgent(pack: Pack): ManagedAgentRender {
  const skipped: SkippedArtifact[] = [];
  const skills = pack.artifacts.filter((a): a is SkillArtifact => a.type === "skill");
  const mcp = pack.artifacts.filter((a): a is McpServerArtifact => a.type === "mcp_server");
  const instr = pack.artifacts.filter((a): a is InstructionsArtifact => a.type === "instructions");
  const hooks = pack.artifacts.filter((a): a is HookArtifact => a.type === "hook");

  // instructions -> single system prompt (provenance preserved under "## <name>")
  const system = instr.map((i) => `## ${i.name}\n\n${i.content}`).join("\n\n---\n\n");

  // skills -> custom skills to create (cap 20)
  const skillBodies: { name: string; content: string }[] = [];
  for (const s of skills) {
    if (skillBodies.length >= MAX_SKILLS) { skipped.push({ artifact: s.name, type: "skill", reason: "exceeds Managed Agents 20-skill cap" }); continue; }
    skillBodies.push({ name: s.name, content: s.content });
  }

  // mcp -> mcp_servers (URL transport only; stdio has no endpoint), cap 20
  const mcp_servers: { type: "url"; name: string; url: string }[] = [];
  for (const m of mcp) {
    if (m.transport === "stdio") { skipped.push({ artifact: m.name, type: "mcp_server", reason: "stdio MCP unsupported on Managed Agents (needs a URL endpoint)" }); continue; }
    const url = typeof m.config.url === "string" ? m.config.url : "";
    if (!url) { skipped.push({ artifact: m.name, type: "mcp_server", reason: `${m.transport} MCP has no url` }); continue; }
    if (mcp_servers.length >= MAX_MCP) { skipped.push({ artifact: m.name, type: "mcp_server", reason: "exceeds Managed Agents 20-server cap" }); continue; }
    mcp_servers.push({ type: "url", name: m.name, url });
  }

  // hooks -> no Managed Agents equivalent
  for (const h of hooks) skipped.push({ artifact: h.name, type: "hook", reason: "hooks have no Managed Agents equivalent" });

  const tools: ManagedAgentPayload["tools"] = [
    { type: "agent_toolset_20260401" },
    ...mcp_servers.map((s) => ({ type: "mcp_toolset" as const, mcp_server_name: s.name })),
  ];

  return {
    payload: { name: pack.name, model: MANAGED_AGENTS_MODEL, system, mcp_servers, skills: skillBodies.map((s) => ({ name: s.name })), tools },
    skillBodies,
    skipped,
    vaultSecrets: pack.requiredSecrets,
  };
}
