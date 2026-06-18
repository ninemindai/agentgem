// src/pack/targets.ts
// Render a normalized Pack INTO a harness's on-disk layout. Pure; writes nothing — returns an
// in-memory FileTree. Targets compose shared per-artifact-type convention renderers; unmappable
// artifacts are skipped with a reason. Materialize re-renders an already-redacted Pack; the
// runner rebinds real secrets from pack.requiredSecrets at install.
import type {
  Pack, ArtifactType,
  SkillArtifact, McpServerArtifact, InstructionsArtifact, HookArtifact,
} from "./types.js";
import { tomlMcpServers } from "./toml.js";

export type TargetId = "claude" | "codex" | "agents" | "hermes" | "eve";
export type FileTree = Record<string, string>;

export interface SkippedArtifact { artifact: string; type: ArtifactType; reason: string }
export interface MaterializeResult { files: FileTree; skipped: SkippedArtifact[] }

interface TargetSpec {
  id: TargetId;
  label: string;
  skill?: (a: SkillArtifact) => FileTree;
  mcp?: (servers: McpServerArtifact[]) => FileTree;
  instructions?: (all: InstructionsArtifact[]) => FileTree;
  hook?: (hooks: HookArtifact[]) => FileTree;
}

// ── shared convention renderers ──
const skillSkillMd = (a: SkillArtifact): FileTree => ({ [`skills/${a.name}/SKILL.md`]: a.content });
const skillDescriptionMd = (a: SkillArtifact): FileTree => ({ [`skills/${a.name}/DESCRIPTION.md`]: a.content });
// Eve: a project under agent/. Flat markdown skills (frontmatter optional — description falls back
// to the first line), a single agent/instructions.md, and one TS connection file per MCP server.
const skillEveMd = (a: SkillArtifact): FileTree => ({ [`agent/skills/${a.name}.md`]: a.content });
// Eve MCP connections: one TS file per http/sse server. URL/auth never reach the model; auth reads
// the secret from an env var (the redacted server's secretRef name) — never a value.
const mcpEveConnections = (servers: McpServerArtifact[]): FileTree => {
  const out: FileTree = {};
  for (const s of servers) {
    const url = typeof s.config.url === "string" ? s.config.url : "";
    if (!/^https?:\/\//.test(url)) continue; // stdio / no-url can't be an Eve MCP client connection
    const secret = s.secretRefs && s.secretRefs[0] ? s.secretRefs[0].name : "";
    const auth = secret ? `,\n  auth: { getToken: async () => ({ token: process.env.${secret}! }) }` : "";
    out[`agent/connections/${s.name}.ts`] =
      `import { defineMcpClientConnection } from "eve/connections";\n\n` +
      `export default defineMcpClientConnection({\n  url: ${JSON.stringify(url)},\n  description: ${JSON.stringify(s.name)}${auth},\n});\n`;
  }
  return out;
};

// Multiple instruction artifacts concatenate into the target's single canonical file,
// each under a "## <name>" separator so provenance survives.
const concatInstructions = (file: string) => (all: InstructionsArtifact[]): FileTree =>
  ({ [file]: all.map((i) => `## ${i.name}\n\n${i.content}`).join("\n\n---\n\n") });
const instructionsClaudeMd = concatInstructions("CLAUDE.md");
const instructionsAgentsMd = concatInstructions("AGENTS.md");
const instructionsSoulMd = concatInstructions("SOUL.md");

const mcpDotMcpJson = (servers: McpServerArtifact[]): FileTree =>
  ({ ".mcp.json": JSON.stringify({ mcpServers: Object.fromEntries(servers.map((s) => [s.name, s.config])) }, null, 2) });
const mcpCodexToml = (servers: McpServerArtifact[]): FileTree =>
  ({ "config.toml": tomlMcpServers(servers) });

// Reconstruct settings.json's `.hooks` event map. HookArtifact.config IS the group object
// ({ matcher?, hooks: [...] }) captured by introspect, so we group those back under their event.
function hooksToEventMap(hooks: HookArtifact[]): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const h of hooks) (out[h.event] ??= []).push(h.config);
  return out;
}
const hooksSettingsJson = (hooks: HookArtifact[]): FileTree =>
  ({ "settings.json": JSON.stringify({ hooks: hooksToEventMap(hooks) }, null, 2) });

// ── targets compose the shared renderers (convergence is literal, not duplicated) ──
export const TARGET_REGISTRY: Record<TargetId, TargetSpec> = {
  claude: { id: "claude", label: "Claude", skill: skillSkillMd,       instructions: instructionsClaudeMd, mcp: mcpDotMcpJson, hook: hooksSettingsJson },
  codex:  { id: "codex",  label: "Codex",  skill: skillSkillMd,       instructions: instructionsAgentsMd, mcp: mcpCodexToml },
  agents: { id: "agents", label: "Agents", skill: skillSkillMd,       instructions: instructionsAgentsMd },
  hermes: { id: "hermes", label: "Hermes", skill: skillDescriptionMd, instructions: instructionsSoulMd },
  // Eve project layout (agent/...). Hooks are event-reacting code in Eve, not config -> unsupported.
  eve:    { id: "eve",    label: "Eve",    skill: skillEveMd,         instructions: concatInstructions("agent/instructions.md"), mcp: mcpEveConnections },
};

export function materialize(pack: Pack, target: TargetId): MaterializeResult {
  const spec = TARGET_REGISTRY[target];
  const files: FileTree = {};
  const skipped: SkippedArtifact[] = [];

  const merge = (tree: FileTree, artifact: string, type: ArtifactType) => {
    for (const [path, content] of Object.entries(tree)) {
      if (path in files) { skipped.push({ artifact, type, reason: `path collision with an earlier ${type} at ${path}` }); continue; }
      files[path] = content;
    }
  };
  const skipAll = (arr: { name: string }[], type: ArtifactType) =>
    arr.forEach((a) => skipped.push({ artifact: a.name, type, reason: `${type} unsupported on ${target}` }));

  const skills = pack.artifacts.filter((a): a is SkillArtifact => a.type === "skill");
  const mcp = pack.artifacts.filter((a): a is McpServerArtifact => a.type === "mcp_server");
  const instr = pack.artifacts.filter((a): a is InstructionsArtifact => a.type === "instructions");
  const hooks = pack.artifacts.filter((a): a is HookArtifact => a.type === "hook");

  if (spec.skill) for (const s of skills) merge(spec.skill(s), s.name, "skill");
  else skipAll(skills, "skill");

  if (instr.length) {
    if (spec.instructions) merge(spec.instructions(instr), instr.map((i) => i.name).join(", "), "instructions");
    else skipAll(instr, "instructions");
  }
  if (mcp.length) {
    if (spec.mcp) merge(spec.mcp(mcp), mcp.map((m) => m.name).join(", "), "mcp_server");
    else skipAll(mcp, "mcp_server");
  }
  if (hooks.length) {
    if (spec.hook) merge(spec.hook(hooks), hooks.map((h) => h.name).join(", "), "hook");
    else skipAll(hooks, "hook");
  }

  return { files, skipped };
}

export function compatibility(pack: Pack): Record<TargetId, { supported: number; skipped: number }> {
  const out = {} as Record<TargetId, { supported: number; skipped: number }>;
  for (const id of Object.keys(TARGET_REGISTRY) as TargetId[]) {
    const r = materialize(pack, id);
    out[id] = { supported: pack.artifacts.length - r.skipped.length, skipped: r.skipped.length };
  }
  return out;
}
