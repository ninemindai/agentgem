// src/gem/publish.ts
// Pure render: a (redacted) Gem -> the Managed Agents `agents.create` payload (sans skills) plus
// the skills to register and the side-lists. No network, no secret values.
//
// Skills become true on-demand Agent Skills: each is registered via the Skills API at publish
// (client.beta.skills.create -> skill_id) and referenced as { type:"custom", skill_id, version }.
// Max 20 skills per agent (overflow skipped). MCP needs a URL endpoint (stdio skipped); hooks have
// no Managed Agents equivalent (skipped).
import type {
  Gem, ArtifactType, SecretRequirement,
  SkillArtifact, McpServerArtifact, InstructionsArtifact, HookArtifact,
} from "./types.js";

export const MANAGED_AGENTS_MODEL = "claude-opus-4-8";
const MAX_SKILLS = 20;
const MAX_MCP = 20;

export interface ManagedAgentPayload {
  name: string;
  model: string;
  system: string;
  mcp_servers: { type: "url"; name: string; url: string }[];
  tools: ({ type: "agent_toolset_20260401" } | { type: "mcp_toolset"; mcp_server_name: string })[];
}

export interface SkippedArtifact { artifact: string; type: ArtifactType; reason: string }

export interface ManagedAgentRender {
  payload: ManagedAgentPayload;                    // agents.create payload minus skills (added at publish)
  skillsToRegister: { name: string; content: string }[]; // each -> Skills API create -> custom skill ref
  skipped: SkippedArtifact[];
  vaultSecrets: SecretRequirement[];               // names only — operator adds these to a vault post-publish
}

export function renderManagedAgent(gem: Gem): ManagedAgentRender {
  const skipped: SkippedArtifact[] = [];
  const skills = gem.artifacts.filter((a): a is SkillArtifact => a.type === "skill");
  const mcp = gem.artifacts.filter((a): a is McpServerArtifact => a.type === "mcp_server");
  const instr = gem.artifacts.filter((a): a is InstructionsArtifact => a.type === "instructions");
  const hooks = gem.artifacts.filter((a): a is HookArtifact => a.type === "hook");

  // instructions -> system prompt (## <name>); skills are NOT inlined — they become Agent Skills.
  const system = instr.map((i) => `## ${i.name}\n\n${i.content}`).join("\n\n---\n\n");

  // skills -> custom skills to register (cap 20)
  const skillsToRegister: { name: string; content: string }[] = [];
  for (const s of skills) {
    if (skillsToRegister.length >= MAX_SKILLS) { skipped.push({ artifact: s.name, type: "skill", reason: "exceeds the Managed Agents 20-skill cap" }); continue; }
    skillsToRegister.push({ name: s.name, content: s.content });
  }

  // mcp -> mcp_servers (URL transport only; stdio has no endpoint), cap 20
  const mcp_servers: { type: "url"; name: string; url: string }[] = [];
  const mappedMcpNames = new Set<string>();
  for (const m of mcp) {
    if (m.transport === "stdio") { skipped.push({ artifact: m.name, type: "mcp_server", reason: "stdio MCP unsupported on Managed Agents (needs a URL endpoint)" }); continue; }
    const url = typeof m.config.url === "string" ? m.config.url : "";
    // Require a real http(s) endpoint. A redaction-stripped or malformed url (e.g. "<redacted>"
    // from a token-bearing query string) must not ship a broken server entry.
    if (!/^https?:\/\//.test(url)) { skipped.push({ artifact: m.name, type: "mcp_server", reason: url ? `${m.transport} MCP url is not a usable https endpoint (redacted or malformed)` : `${m.transport} MCP has no url` }); continue; }
    if (mappedMcpNames.has(m.name)) { skipped.push({ artifact: m.name, type: "mcp_server", reason: "duplicate Managed Agents MCP server name" }); continue; }
    if (mcp_servers.length >= MAX_MCP) { skipped.push({ artifact: m.name, type: "mcp_server", reason: "exceeds Managed Agents 20-server cap" }); continue; }
    mcp_servers.push({ type: "url", name: m.name, url });
    mappedMcpNames.add(m.name);
  }

  // hooks -> no Managed Agents equivalent
  for (const h of hooks) skipped.push({ artifact: h.name, type: "hook", reason: "hooks have no Managed Agents equivalent" });

  const tools: ManagedAgentPayload["tools"] = [
    { type: "agent_toolset_20260401" },
    ...mcp_servers.map((s) => ({ type: "mcp_toolset" as const, mcp_server_name: s.name })),
  ];

  // Only surface vault secrets for MCP servers that actually mapped.
  const mappedNames = new Set(mcp_servers.map((m) => m.name));
  const vaultSecrets = gem.requiredSecrets.filter((s) => mappedNames.has(s.artifact));

  return { payload: { name: gem.name, model: MANAGED_AGENTS_MODEL, system, mcp_servers, tools }, skillsToRegister, skipped, vaultSecrets };
}
