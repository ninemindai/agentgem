// src/pack/publish.ts
// Pure render: a (redacted) Pack -> the exact Claude Managed Agents `agents.create` payload, plus
// the side-lists the operator needs. No network, no secret values.
//
// v1 skill handling: skills are INLINED into the agent `system` prompt (`# Skill: <name>`), using
// only the confirmed agents.create(system) binding. True on-demand Agent Skills (register each via
// the Skills API -> reference by skill_id) is a documented follow-up, blocked on verifying the
// Skills API create body. The 100K system-prompt limit is respected; overflow skills are skipped.
import type {
  Pack, ArtifactType, SecretRequirement,
  SkillArtifact, McpServerArtifact, InstructionsArtifact, HookArtifact,
} from "./types.js";

export const MANAGED_AGENTS_MODEL = "claude-opus-4-8";
export const SYSTEM_LIMIT = 100_000; // Managed Agents system-prompt cap (chars)
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
  payload: ManagedAgentPayload; // exactly what agents.create receives
  inlinedSkills: string[];      // skill names folded into the system prompt (preview visibility)
  skipped: SkippedArtifact[];
  vaultSecrets: SecretRequirement[]; // names only — operator adds these to a vault post-publish
}

export function renderManagedAgent(pack: Pack): ManagedAgentRender {
  const skipped: SkippedArtifact[] = [];
  const skills = pack.artifacts.filter((a): a is SkillArtifact => a.type === "skill");
  const mcp = pack.artifacts.filter((a): a is McpServerArtifact => a.type === "mcp_server");
  const instr = pack.artifacts.filter((a): a is InstructionsArtifact => a.type === "instructions");
  const hooks = pack.artifacts.filter((a): a is HookArtifact => a.type === "hook");

  // Build the system prompt: instructions first (## <name>), then skills (# Skill: <name>),
  // staying under the 100K char cap. Overflow skills are skipped with a reason.
  const parts: string[] = instr.map((i) => `## ${i.name}\n\n${i.content}`);
  let used = parts.join("\n\n---\n\n").length;
  const inlinedSkills: string[] = [];
  for (const s of skills) {
    const block = `# Skill: ${s.name}\n\n${s.content}`;
    if (used + block.length + 7 > SYSTEM_LIMIT) { skipped.push({ artifact: s.name, type: "skill", reason: "would exceed the Managed Agents 100K system-prompt limit" }); continue; }
    parts.push(block);
    used += block.length + 7; // separator
    inlinedSkills.push(s.name);
  }
  const system = parts.join("\n\n---\n\n");

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

  // Only surface vault secrets for MCP servers that actually mapped — a skipped stdio server
  // (or a hook) won't be created on the agent, so its credential isn't needed in a vault.
  const mappedNames = new Set(mcp_servers.map((m) => m.name));
  const vaultSecrets = pack.requiredSecrets.filter((s) => mappedNames.has(s.artifact));

  return { payload: { name: pack.name, model: MANAGED_AGENTS_MODEL, system, mcp_servers, tools }, inlinedSkills, skipped, vaultSecrets };
}
