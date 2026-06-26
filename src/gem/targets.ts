// src/gem/targets.ts
// Render a normalized Gem INTO a harness's on-disk layout. Pure; writes nothing — returns an
// in-memory FileTree. Targets compose shared per-artifact-type convention renderers; unmappable
// artifacts are skipped with a reason. Materialize re-renders an already-redacted Gem; the
// runner rebinds real secrets from gem.requiredSecrets at install.
import type {
  Gem, ArtifactType, SecretRequirement, SecretRef, ChannelArtifact,
  SkillArtifact, McpServerArtifact, InstructionsArtifact, HookArtifact,
} from "./types.js";
import { channelScaffold } from "./channels.js";
import { tomlMcpServers } from "./toml.js";
import { stdioProxyRunner, PROXY_BASE_PORT, PROXY_HOST } from "./mcpProxy.js";

export type TargetId = "claude" | "codex" | "agents" | "hermes" | "eve" | "flue" | "openai-sandbox" | "agentcore" | "a2a";
export type FileTree = Record<string, string>;

export interface SkippedArtifact { artifact: string; type: ArtifactType; reason: string }
export interface MaterializeResult { files: FileTree; skipped: SkippedArtifact[] }

// Per-materialization options that some targets honor (e.g. eve's deploy-time auth posture,
// a2a's opt-in runnable server flavor).
export interface MaterializeOpts { eveAuth?: "placeholder" | "public"; a2aServer?: boolean }

interface TargetSpec {
  id: TargetId;
  label: string;
  skill?: (a: SkillArtifact) => FileTree;
  mcp?: (servers: McpServerArtifact[]) => MaterializeResult;
  instructions?: (all: InstructionsArtifact[]) => FileTree;
  hook?: (hooks: HookArtifact[]) => FileTree;
  channel?: (channels: ChannelArtifact[]) => MaterializeResult;
  compose?: (gem: Gem, opts: MaterializeOpts) => MaterializeResult; // cross-cutting file(s) that see the whole gem (runs last)
}

export function safePathSegment(name: string): string {
  const safe = name.normalize("NFKC").replace(/[^A-Za-z0-9._-]/g, "_");
  return safe === "." || safe === ".." || safe.length === 0 ? "unnamed" : safe;
}

// Eve derives skill/connection names from the filename and requires the segment to START with an
// alphanumeric character. Strip leading non-alphanumerics from the safe segment.
const eveSegment = (name: string): string => safePathSegment(name).replace(/^[^A-Za-z0-9]+/, "") || "unnamed";

// Flue worker + agent-file name: lower-kebab, alphanumeric+dashes only (Cloudflare worker name rules).
const flueName = (name: string): string => {
  const s = name.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s.length ? s : "agent";
};
// Exported alias so run.ts and other callers share one source of truth for the worker name.
export function flueWorkerName(gemName: string): string { return flueName(gemName); }
// PascalCase of the kebab name; flue derives the Durable Object class as `Flue<Pascal>Agent`.
const fluePascal = (name: string): string =>
  flueName(name).split("-").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join("") || "Agent";
// Flue skills live under src/ (the agent file is src/agents/<name>.ts and imports ../skills/...).
const skillFlueMd = (a: SkillArtifact): FileTree => ({ [`src/skills/${safePathSegment(a.name)}/SKILL.md`]: a.content });

const rendered = (files: FileTree): MaterializeResult => ({ files, skipped: [] });

// MCP header secrets -> [headerName, envVarName] entries, Authorization first. Shared by the HTTP/SSE
// renderers (flue / openai-sandbox / a2a); the env-var NAME is emitted, never a value. Callers that
// require header-only auth check separately for a non-`headers.` secret (the unsupported case).
const headerSecretEntries = (refs: SecretRef[]): (readonly [string, string])[] => {
  const authorization = refs.find((r) => r.location.toLowerCase() === "headers.authorization");
  return [
    ...(authorization ? [["Authorization", authorization.name] as const] : []),
    ...refs.filter((r) => /^headers\./i.test(r.location) && r !== authorization)
          .map((r) => [r.location.slice("headers.".length), r.name] as const),
  ];
};

// ── shared convention renderers ──
const skillSkillMd = (a: SkillArtifact): FileTree => ({ [`skills/${safePathSegment(a.name)}/SKILL.md`]: a.content });
const skillDescriptionMd = (a: SkillArtifact): FileTree => ({ [`skills/${safePathSegment(a.name)}/DESCRIPTION.md`]: a.content });
// Strip a leading YAML frontmatter block ("---\n … \n---\n") if present; return the body.
function stripYamlFrontmatter(content: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(content);
  return m ? content.slice(m[0].length) : content;
}
// Eve authored-skill shape allows only description/metadata/license. Re-emit a clean description
// (from the artifact) over the original body; omit frontmatter entirely when there's no description
// (eve falls back to the first body line). JSON.stringify yields a safe double-quoted YAML scalar.
const skillEveMd = (a: SkillArtifact): FileTree => {
  const body = stripYamlFrontmatter(a.content);
  const desc = a.description?.trim();
  const out = desc ? `---\ndescription: ${JSON.stringify(desc)}\n---\n${body}` : body;
  return { [`agent/skills/${eveSegment(a.name)}.md`]: out };
};
// AgentCore path-skills live on the harness filesystem; emit each skill body under .agents/skills/<seg>/.
const skillAgentcoreMd = (a: SkillArtifact): FileTree => ({ [`.agents/skills/${safePathSegment(a.name)}/SKILL.md`]: a.content });
const eveConnection = (server: McpServerArtifact, url: string): string => {
  const refs = server.secretRefs ?? [];
  const authorization = refs.find((r) => r.location.toLowerCase() === "headers.authorization");
  const headerEntries = refs
    .filter((r) => /^headers\./i.test(r.location) && r !== authorization)
    .map((r) => [r.location.slice("headers.".length), r.name] as const);
  const auth = authorization
    ? `,\n  auth: { getToken: async () => ({ token: process.env[${JSON.stringify(authorization.name)}]! }) }`
    : "";
  const headers = headerEntries.length
    ? `,\n  headers: { ${headerEntries.map(([header, env]) => `${JSON.stringify(header)}: process.env[${JSON.stringify(env)}]!`).join(", ")} }`
    : "";
  return `import { defineMcpClientConnection } from "eve/connections";\n\nexport default defineMcpClientConnection({\n  url: ${JSON.stringify(url)},\n  description: ${JSON.stringify(server.name)}${auth}${headers},\n});\n`;
};
// Eve MCP connections: one TS file per http/sse server (auth reads the secret from an env var name,
// never a value). eve connections are URL-only, so stdio (and url-less http) servers are skipped.
const mcpEveConnections = (servers: McpServerArtifact[]): MaterializeResult => {
  const files: FileTree = {};
  const skipped: SkippedArtifact[] = [];
  for (const s of servers) {
    const segment = eveSegment(s.name);
    const connectionPath = `agent/connections/${segment}.ts`;
    if (connectionPath in files) {
      skipped.push({ artifact: s.name, type: "mcp_server", reason: `path collision with an earlier mcp_server at ${connectionPath}` });
      continue;
    }
    const url = typeof s.config.url === "string" ? s.config.url : "";
    if (/^https?:\/\//.test(url)) {
      const unsupportedSecret = (s.secretRefs ?? []).find((r) => !/^headers\./i.test(r.location));
      if (unsupportedSecret) {
        skipped.push({ artifact: s.name, type: "mcp_server", reason: `Eve cannot map secret at ${unsupportedSecret.location}` });
        continue;
      }
      files[connectionPath] = eveConnection(s, url);
    } else {
      skipped.push({ artifact: s.name, type: "mcp_server", reason: `eve connections require an HTTP/SSE URL; ${s.transport} MCP unsupported` });
    }
  }
  return { files, skipped };
};

// ── AgentCore harness renderers ──
const AGENTCORE_MODEL_ID = "global.anthropic.claude-sonnet-4-6";
// A token-vault placeholder for a secret header value. REGION/ACCOUNT are left as literal
// placeholders for the user to fill (SECRETS.md lists the `agentcore add credential` commands).
const agentcoreSecretRef = (name: string): string =>
  `\${arn:aws:bedrock-agentcore:REGION:ACCOUNT:token-vault/default/apikeycredentialprovider/${name}}`;

// http/sse MCP -> a remote_mcp tool. Secret header values become token-vault placeholders.
// stdio (and url-less http) servers are skipped: the harness is remote-URL only.
const agentcoreMcpTools = (servers: McpServerArtifact[]): { tools: unknown[]; skipped: SkippedArtifact[] } => {
  const tools: unknown[] = [];
  const skipped: SkippedArtifact[] = [];
  for (const s of servers) {
    const url = typeof s.config.url === "string" ? s.config.url : "";
    if (!/^https?:\/\//.test(url)) {
      skipped.push({ artifact: s.name, type: "mcp_server", reason: `AgentCore remote_mcp requires an HTTP/SSE URL; ${s.transport === "stdio" ? "stdio MCP unsupported" : "no URL found"}` });
      continue;
    }
    const refs = s.secretRefs ?? [];
    const unsupportedSecret = refs.find((r) => !/^headers\./i.test(r.location));
    if (unsupportedSecret) {
      skipped.push({ artifact: s.name, type: "mcp_server", reason: `AgentCore cannot map secret at ${unsupportedSecret.location}` });
      continue;
    }
    const headerEntries = refs
      .filter((r) => /^headers\./i.test(r.location))
      .map((r) => [r.location.slice("headers.".length), agentcoreSecretRef(r.name)] as const);
    const remoteMcp: Record<string, unknown> = { url };
    if (headerEntries.length) remoteMcp.headers = Object.fromEntries(headerEntries);
    tools.push({ type: "remote_mcp", name: s.name, config: { remoteMcp } });
  }
  return { tools, skipped };
};

// Assemble the harness.json object. model is always present; systemPrompt/tools/skills only when non-empty.
export const buildAgentcoreHarness = (gem: Gem): { harness: Record<string, unknown>; skipped: SkippedArtifact[] } => {
  const skills = gem.artifacts.filter((a): a is SkillArtifact => a.type === "skill");
  const mcp = gem.artifacts.filter((a): a is McpServerArtifact => a.type === "mcp_server");
  const instr = gem.artifacts.filter((a): a is InstructionsArtifact => a.type === "instructions");
  const { tools, skipped } = agentcoreMcpTools(mcp);
  const harness: Record<string, unknown> = { model: { bedrockModelConfig: { modelId: AGENTCORE_MODEL_ID } } };
  if (instr.length) harness.systemPrompt = [{ text: instr.map((i) => `## ${i.name}\n\n${i.content}`).join("\n\n---\n\n") }];
  if (tools.length) harness.tools = tools;
  if (skills.length) {
    // Dedupe by path: two skill names can collapse to the same safePathSegment, and the harness
    // skills[] must not carry a duplicate path (the files are deduped by materialize's merge).
    const seen = new Set<string>();
    const paths: { path: string }[] = [];
    for (const s of skills) {
      const path = `.agents/skills/${safePathSegment(s.name)}`;
      if (seen.has(path)) continue;
      seen.add(path);
      paths.push({ path });
    }
    harness.skills = paths;
  }
  return { harness, skipped };
};

// ── AgentCore project scaffold (harness.json + deployment files) ──
const AGENTCORE_DOCKERFILE = `# AgentCore harness custom image: bakes local skills onto the harness filesystem
# so the harness.json path-skills resolve. Build with: agentcore deploy --build Container
FROM public.ecr.aws/bedrock-agentcore/harness-base:latest
COPY .agents/skills/ .agents/skills/
`;
// Matches the shape `agentcore create` scaffolds (schema v1): top-level name/version/managedBy +
// the resource arrays the CLI expects, with the single harness registered under `harnesses`.
const agentcoreProjectJson = (gemName: string): string => {
  const name = safePathSegment(gemName);
  return JSON.stringify({
    $schema: "https://schema.agentcore.aws.dev/v1/agentcore.json",
    name,
    version: 1,
    managedBy: "CDK",
    tags: { "agentcore:created-by": "agentgem", "agentcore:project-name": name },
    runtimes: [], memories: [], knowledgeBases: [], credentials: [], evaluators: [],
    onlineEvalConfigs: [], agentCoreGateways: [], policyEngines: [], configBundles: [],
    abTests: [], harnesses: [{ name, path: `app/${name}` }], datasets: [], payments: [],
  }, null, 2) + "\n";
};
// `agentcore create` scaffolds an empty targets list; `agentcore deploy` resolves account/region from AWS creds.
const AGENTCORE_AWS_TARGETS = "[]\n";
const agentcoreSecretsMd = (secrets: SecretRequirement[]): string => {
  if (!secrets.length) return `# Secrets\n\nThis agent declares no secrets.\n`;
  const lines = secrets.map((s) => `- \`${s.name}\` (for ${s.artifact} at ${s.location}):\n  \`\`\`\n  agentcore add credential --type api-key --name ${s.name} --api-key <value>\n  \`\`\``);
  return `# Secrets\n\nRegister each credential in AgentCore Identity, then replace \`REGION\`/\`ACCOUNT\` in the \`\${arn:...}\` placeholders in \`app/<agent>/harness.json\`:\n\n${lines.join("\n")}\n`;
};

// Cross-cutting scaffold in the AgentCore CLI's project format (verified against `agentcore create`):
// harness.json uses model {provider,modelId} and carries no inline prompt — the system prompt lives in
// a sibling system-prompt.md. (The raw CreateHarness API shape, used by the publish backend, differs.)
export const agentcoreComposeProject = (gem: Gem): MaterializeResult => {
  const seg = safePathSegment(gem.name);
  const { harness, skipped } = buildAgentcoreHarness(gem);
  const systemPrompt = (harness.systemPrompt as { text: string }[] | undefined)?.[0]?.text ?? "You are a helpful assistant.";
  const harnessJson = {
    name: seg,
    model: { provider: "bedrock", modelId: AGENTCORE_MODEL_ID },
    tools: (harness.tools as unknown[]) ?? [],
    skills: (harness.skills as unknown[]) ?? [],
  };
  return {
    files: {
      [`app/${seg}/harness.json`]: JSON.stringify(harnessJson, null, 2) + "\n",
      [`app/${seg}/system-prompt.md`]: systemPrompt + "\n",
      "agentcore/agentcore.json": agentcoreProjectJson(gem.name),
      "agentcore/aws-targets.json": AGENTCORE_AWS_TARGETS,
      "Dockerfile": AGENTCORE_DOCKERFILE,
      "SECRETS.md": agentcoreSecretsMd(gem.requiredSecrets),
    },
    skipped,
  };
};

// Multiple instruction artifacts concatenate into the target's single canonical file,
// each under a "## <name>" separator so provenance survives.
const concatInstructions = (file: string) => (all: InstructionsArtifact[]): FileTree =>
  ({ [file]: all.map((i) => `## ${i.name}\n\n${i.content}`).join("\n\n---\n\n") });
const instructionsClaudeMd = concatInstructions("CLAUDE.md");
const instructionsAgentsMd = concatInstructions("AGENTS.md");
const instructionsSoulMd = concatInstructions("SOUL.md");

const mcpDotMcpJson = (servers: McpServerArtifact[]): MaterializeResult =>
  rendered({ ".mcp.json": JSON.stringify({ mcpServers: Object.fromEntries(servers.map((s) => [s.name, s.config])) }, null, 2) });
const mcpCodexToml = (servers: McpServerArtifact[]): MaterializeResult =>
  rendered({ "config.toml": tomlMcpServers(servers) });

// Reconstruct settings.json's `.hooks` event map. HookArtifact.config IS the group object
// ({ matcher?, hooks: [...] }) captured by introspect, so we group those back under their event.
function hooksToEventMap(hooks: HookArtifact[]): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const h of hooks) (out[h.event] ??= []).push(h.config);
  return out;
}
const hooksSettingsJson = (hooks: HookArtifact[]): FileTree =>
  ({ "settings.json": JSON.stringify({ hooks: hooksToEventMap(hooks) }, null, 2) });

// Flue: a single src/agents/<gemname>.ts registers the agent. It imports each skill (from
// src/skills/<n>/SKILL.md bodies), folds instruction artifacts into the `instructions` string, and lists
// the skills. MCP connection files are emitted by the `mcp` renderer and imported by the agent file
// (flueComposeAgent), which awaits them and spreads their adapted tools into the agent's `tools`.
function escapeTemplate(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}
// One TS factory per MCP server. http/sse -> a direct remote connection (auth reads the secret from an
// env var name, never a value). stdio -> a localhost connection plus a generated proxy runner under
// proxies/ that bridges the stdio server to HTTP (same mechanism as Eve).
const flueConnection = (server: McpServerArtifact, url: string): string => {
  const headerEntries = headerSecretEntries(server.secretRefs ?? []);
  const transport = server.transport === "sse" ? `,\n  transport: "sse"` : "";
  const headers = headerEntries.length
    ? `,\n  headers: { ${headerEntries.map(([h, env]) => `${JSON.stringify(h)}: process.env[${JSON.stringify(env)}]!`).join(", ")} }`
    : "";
  return `import { connectMcpServer } from "@flue/runtime";\n\nexport default () => connectMcpServer(${JSON.stringify(server.name)}, {\n  url: ${JSON.stringify(url)}${transport}${headers},\n});\n`;
};

// Plan the src/connections/<seg>.ts files (and stdio src/proxies/) for the MCP servers, returning the segs
// that got a file in iteration order. Single source of truth: both the `mcp` renderer (which writes
// the files) and `compose` (which imports them into the agent) consume this, so the agent never
// imports a connection that wasn't emitted, nor strands one that was.
function flueConnectionFiles(servers: McpServerArtifact[]): { files: FileTree; emitted: string[]; skipped: SkippedArtifact[] } {
  const files: FileTree = {};
  const emitted: string[] = [];
  const skipped: SkippedArtifact[] = [];
  let port = PROXY_BASE_PORT;
  for (const s of servers) {
    const seg = safePathSegment(s.name);
    const connectionPath = `src/connections/${seg}.ts`;
    if (connectionPath in files) {
      skipped.push({ artifact: s.name, type: "mcp_server", reason: `path collision with an earlier mcp_server at ${connectionPath}` });
      continue;
    }
    const url = typeof s.config.url === "string" ? s.config.url : "";
    if (/^https?:\/\//.test(url)) {
      const unsupportedSecret = (s.secretRefs ?? []).find((r) => !/^headers\./i.test(r.location));
      if (unsupportedSecret) {
        skipped.push({ artifact: s.name, type: "mcp_server", reason: `Flue cannot map secret at ${unsupportedSecret.location}` });
        continue;
      }
      files[connectionPath] = flueConnection(s, url);
      emitted.push(seg);
    } else if (s.transport === "stdio" && typeof s.config.command === "string") {
      const p = port++;
      const args = Array.isArray(s.config.args) ? s.config.args.filter((a): a is string => typeof a === "string") : [];
      // localhost proxy connection carries no auth headers (the proxy injects the secrets into the stdio process)
      files[connectionPath] = flueConnection({ ...s, secretRefs: undefined }, `http://${PROXY_HOST}:${p}/mcp`);
      files[`src/proxies/${seg}.mjs`] = stdioProxyRunner(s.name, s.config.command, args, (s.secretRefs ?? []).map((r) => r.name), p);
      emitted.push(seg);
    } else {
      skipped.push({ artifact: s.name, type: "mcp_server", reason: `${s.transport} MCP has no usable URL or stdio command` });
    }
  }
  return { files, emitted, skipped };
}

const mcpFlueConnections = (servers: McpServerArtifact[]): MaterializeResult => {
  const { files, skipped } = flueConnectionFiles(servers);
  return { files, skipped };
};
const flueComposeAgent = (gem: Gem): MaterializeResult => {
  const skills = gem.artifacts.filter((a): a is SkillArtifact => a.type === "skill");
  const instr = gem.artifacts.filter((a): a is InstructionsArtifact => a.type === "instructions");
  const mcps = gem.artifacts.filter((a): a is McpServerArtifact => a.type === "mcp_server");
  const skillImports = skills.map((s, i) => `import skill${i} from "../skills/${safePathSegment(s.name)}/SKILL.md" with { type: "skill" };`).join("\n");
  const instructions = instr.map((i) => `## ${i.name}\n\n${i.content}`).join("\n\n---\n\n");
  const skillList = skills.map((_, i) => `skill${i}`).join(", ");

  // Wire the emitted MCP connections into the agent's tools. connectMcpServer is async, so when there
  // are connections the initializer goes async, awaits the connection thunks, and spreads their adapted
  // tools. The connections stay open for the agent's lifetime (no .close() — unlike a transient run()).
  const { emitted } = flueConnectionFiles(mcps);
  const connImports = emitted.map((seg, i) => `import conn${i} from "../connections/${seg}.ts";`).join("\n");
  const importBlock = [skillImports, connImports].filter(Boolean).join("\n");
  const fields = [`model: "anthropic/claude-sonnet-4-6",`, `instructions,`, `skills: [${skillList}],`];
  const indent = (lines: string[], n: number) => lines.map((l) => " ".repeat(n) + l).join("\n");
  const initializer = emitted.length
    ? `createAgent(async () => {
  const connections = await Promise.all([${emitted.map((_, i) => `conn${i}()`).join(", ")}]);
  return {
${indent([...fields, `tools: connections.flatMap((c) => c.tools),`], 4)}
  };
})`
    : `createAgent(() => ({
${indent(fields, 2)}
}))`;

  const file =
`import { createAgent, type AgentRouteHandler } from "@flue/runtime";
${importBlock}${importBlock ? "\n" : ""}
export const route: AgentRouteHandler = async (_c, next) => next();

const instructions = \`${escapeTemplate(instructions)}\`;

export default ${initializer};
`;
  const wname = flueWorkerName(gem.name); // single source of truth shared with run.ts's deploy record
  const doClass = `Flue${fluePascal(gem.name)}Agent`;
  const flueConfig = `import { defineConfig } from "@flue/cli/config";\nexport default defineConfig({ target: "cloudflare" });\n`;
  const pkg = JSON.stringify({
    name: wname, version: "0.1.0", private: true, type: "module",
    scripts: { build: "flue build --target cloudflare", deploy: "wrangler deploy" },
    dependencies: { "@flue/runtime": "^1.0.0-beta.2", valibot: "^1", agents: "^0.14.1" },
    devDependencies: { "@flue/cli": "^1.0.0-beta.1", wrangler: "^4" },
  }, null, 2) + "\n";
  const wrangler = JSON.stringify({
    name: wname,
    compatibility_date: "2026-06-01",
    compatibility_flags: ["nodejs_compat"],
    migrations: [{ tag: "v1", new_sqlite_classes: ["FlueRegistry", doClass] }],
  }, null, 2) + "\n";
  return rendered({
    [`src/agents/${wname}.ts`]: file,
    "flue.config.ts": flueConfig,
    "package.json": pkg,
    "wrangler.jsonc": wrangler,
  });
};

// OpenAI Agents SDK SandboxAgent: one <gemname>.agent.ts composes everything. Skill bodies are real
// files (skillSkillMd) seeded read-only via the Manifest; instructions fold into the `instructions`
// string; MCP servers are added inline in Task 2. No proxy bridge (the SDK has native stdio MCP).

// Per-server MCP renderer for OpenAI SandboxAgent (inline, native stdio + streamable-http).
type SandboxServer = { code: string; cls: "MCPServerStreamableHttp" | "MCPServerStdio" } | { skip: string };
const sandboxMcpServer = (s: McpServerArtifact): SandboxServer => {
  const url = typeof s.config.url === "string" ? s.config.url : "";
  if (/^https?:\/\//.test(url)) {
    const refs = s.secretRefs ?? [];
    const unsupported = refs.find((r) => !/^headers\./i.test(r.location));
    if (unsupported) return { skip: `OpenAI sandbox cannot map secret at ${unsupported.location}` };
    const headerEntries = headerSecretEntries(refs);
    const requestInit = headerEntries.length
      ? `, requestInit: { headers: { ${headerEntries.map(([h, e]) => `${JSON.stringify(h)}: process.env[${JSON.stringify(e)}]!`).join(", ")} } }`
      : "";
    return { code: `  new MCPServerStreamableHttp({ name: ${JSON.stringify(s.name)}, url: ${JSON.stringify(url)}${requestInit} }),`, cls: "MCPServerStreamableHttp" };
  }
  if (s.transport === "stdio" && typeof s.config.command === "string") {
    const args = Array.isArray(s.config.args) ? s.config.args.filter((a): a is string => typeof a === "string") : [];
    const envNames = (s.secretRefs ?? []).map((r) => r.name);
    const argsStr = args.length ? `, args: ${JSON.stringify(args)}` : "";
    const envStr = envNames.length ? `, env: { ${envNames.map((n) => `${JSON.stringify(n)}: process.env[${JSON.stringify(n)}]!`).join(", ")} }` : "";
    return { code: `  new MCPServerStdio({ name: ${JSON.stringify(s.name)}, command: ${JSON.stringify(s.config.command)}${argsStr}${envStr} }),`, cls: "MCPServerStdio" };
  }
  return { skip: `${s.transport} MCP has no usable URL or stdio command` };
};

const sandboxComposeAgent = (gem: Gem): MaterializeResult => {
  const skills = gem.artifacts.filter((a): a is SkillArtifact => a.type === "skill");
  const instr = gem.artifacts.filter((a): a is InstructionsArtifact => a.type === "instructions");
  const mcps = gem.artifacts.filter((a): a is McpServerArtifact => a.type === "mcp_server");
  const instructions = instr.map((i) => `## ${i.name}\n\n${i.content}`).join("\n\n---\n\n");
  const hasSkills = skills.length > 0;
  const sandboxImport = hasSkills
    ? `import { SandboxAgent, Manifest, localDir, shell, filesystem, skills, compaction } from "@openai/agents/sandbox";`
    : `import { SandboxAgent, Manifest, shell, filesystem, compaction } from "@openai/agents/sandbox";`;
  const capabilities = hasSkills ? "[shell(), filesystem(), skills(), compaction()]" : "[shell(), filesystem(), compaction()]";
  const manifestEntries = hasSkills ? `{ skills: localDir({ from: "skills", readOnly: true }) }` : "{}";

  // Render MCP servers inline.
  const skipped: SkippedArtifact[] = [];
  const serverCodes: string[] = [];
  const usedClasses = new Set<string>();
  for (const s of mcps) {
    const res = sandboxMcpServer(s);
    if ("skip" in res) { skipped.push({ artifact: s.name, type: "mcp_server", reason: res.skip }); continue; }
    serverCodes.push(res.code);
    usedClasses.add(res.cls);
  }
  const mcpImport = usedClasses.size ? `import { ${[...usedClasses].sort().join(", ")} } from "@openai/agents";\n` : "";
  const mcpServers = serverCodes.length ? `\n  mcpServers: [\n${serverCodes.join("\n")}\n  ],` : "";

  const file =
`${sandboxImport}
${mcpImport}
export const agent = new SandboxAgent({
  name: ${JSON.stringify(gem.name)},
  model: "gpt-5.5",
  instructions: \`${escapeTemplate(instructions)}\`,
  capabilities: ${capabilities},
  defaultManifest: new Manifest({ entries: ${manifestEntries} }),${mcpServers}
});
`;
  return { files: { [`${safePathSegment(gem.name)}.agent.ts`]: file }, skipped };
};

// ── Eve runnable-project scaffold (templates pinned to eve 0.11.x, from `eve init`) ──
const EVE_TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "types": ["node"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["agent/**/*.ts", "evals/**/*.ts", ".eve/**/*.d.ts"]
}
`;
const EVE_AGENT_TS = `import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-sonnet-4.6",
});
`;
// eve's channel auth posture. "placeholder" (default) is eve's secure scaffold — deployed agents
// reject non-Vercel-OIDC production requests until you wire a real provider. "public" uses none(),
// making the deployed agent (and its tools) reachable by anyone — handy for a demo / `eve dev`.
const eveChannelTs = (authMode: "placeholder" | "public"): string => authMode === "public"
  ? `import { eveChannel } from "eve/channels/eve";
import { localDev, none } from "eve/channels/auth";

export default eveChannel({
  auth: [
    localDev(),
    // PUBLIC: anyone can reach this agent and call its tools (chosen at deploy time for a demo).
    none(),
  ],
});
`
  : `import { eveChannel } from "eve/channels/eve";
import { localDev, placeholderAuth, vercelOidc } from "eve/channels/auth";

export default eveChannel({
  auth: [
    // Open on localhost for \`eve dev\` and the REPL; ignored in production.
    localDev(),
    // Lets the eve TUI and your Vercel deployments reach the deployed agent.
    vercelOidc(),
    // This placeholder will not allow browser requests in production.
    // Replace it with your app's auth provider, like Auth.js or Clerk,
    // or use none() for a public demo.
    placeholderAuth(),
  ],
});
`;
const EVE_GITIGNORE = `node_modules
.env*
.eve
.vercel
.workflow-data
.next
.output
.nitro
dist
.DS_Store
*.tsbuildinfo
`;
const EVE_VERCELIGNORE = `node_modules
.env*
.eve
.workflow-data
.next
.output
.nitro
dist
`;
const evePackageJson = (gemName: string): string =>
  JSON.stringify({
    name: safePathSegment(gemName).toLowerCase(),
    version: "0.0.0",
    type: "module",
    imports: { "#*": "./agent/*", "#evals/*": "./evals/*" },
    scripts: { build: "eve build", dev: "eve dev", start: "eve start", typecheck: "tsgo" },
    dependencies: { "@vercel/connect": "0.2.2", ai: "7.0.0-beta.178", eve: "^0.11.7", microsandbox: "^0.5.0", zod: "4.4.3" },
    devDependencies: { "@types/node": "24.x", "@typescript/native-preview": "7.0.0-dev.20260523.1" },
    overrides: { ai: "7.0.0-beta.178" },
    resolutions: { ai: "7.0.0-beta.178" },
    engines: { node: "24.x" },
  }, null, 2) + "\n";

// Cross-cutting scaffold: the files `eve init` provides so the rendered agent/ source is runnable.
const eveComposeProject = (gem: Gem, opts: MaterializeOpts = {}): MaterializeResult => {
  const files: FileTree = {
    "package.json": evePackageJson(gem.name),
    "tsconfig.json": EVE_TSCONFIG,
    "agent/agent.ts": EVE_AGENT_TS,
    "agent/channels/eve.ts": eveChannelTs(opts.eveAuth ?? "placeholder"),
    ".gitignore": EVE_GITIGNORE,
    ".vercelignore": EVE_VERCELIGNORE,
  };
  // eve build's discovery REQUIRES agent/instructions.md. The instructions renderer only emits it
  // when the gem has instruction artifacts, so for an instructions-less gem we emit a default here
  // (compose runs last; when instructions exist their file is already present and we don't clobber it).
  if (!gem.artifacts.some((a) => a.type === "instructions")) {
    files["agent/instructions.md"] = `# ${gem.name}\n\nNo instructions were included in this Gem; edit this file to guide the agent.\n`;
  }
  return rendered(files);
};

// Eve channel files: one agent/channels/<name>.ts per declared channel, from the platform registry
// scaffold. "eve" is reserved for the always-on web/auth channel that eveComposeProject emits.
const channelEve = (channels: ChannelArtifact[]): MaterializeResult => {
  const files: FileTree = {};
  const skipped: SkippedArtifact[] = [];
  for (const c of channels) {
    const seg = eveSegment(c.name);
    const path = `agent/channels/${seg}.ts`;
    if (seg === "eve") { skipped.push({ artifact: c.name, type: "channel", reason: "channel name 'eve' is reserved for the web channel" }); continue; }
    if (path in files) { skipped.push({ artifact: c.name, type: "channel", reason: `path collision with an earlier channel at ${path}` }); continue; }
    files[path] = channelScaffold(c.platform);
  }
  return { files, skipped };
};

// ── A2A (Agent2Agent) target ──
// Card primitive: materialize(gem, "a2a") emits a runtime-free Agent Card derived from the gem — the
// A2A discovery surface, publishable to the registry. The Card is the part native to AgentGem's
// "describe an agent" mission; a runnable A2A server is a planned opt-in flavor (MaterializeOpts).
const A2A_PROTOCOL_VERSION = "0.3.0";
const a2aSkillCard = (a: SkillArtifact) => ({
  id: safePathSegment(a.name),
  name: a.name,
  description: a.description?.trim() || `The ${a.name} skill.`,
  tags: ["skill"],
});
// A one-line card description from an instruction artifact: prefer the first non-empty *prose* line
// (instruction files usually open with a throwaway "# Title" heading); fall back to the de-headed
// first line if the doc is headings-only. Only ATX headings ("# " … "###### ") count as headings, so a
// prose line that merely starts with '#' (e.g. "#launch") is kept. Bounded so the card carries a label,
// not a paragraph.
const a2aFirstLine = (s: string): string => {
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => !/^#{1,6}\s/.test(l)) ?? lines[0]?.replace(/^#+\s*/, "") ?? "";
  return line.length > 200 ? line.slice(0, 197).replace(/\s+\S*$/, "") + "…" : line;
};

// Pure Gem -> AgentCard projection. Skills advertise as A2A skills (metadata, not bodies); the first
// instruction line becomes the card description; a skill-less Gem gets a synthesized `chat` skill
// (A2A requires >=1). Emits no secret values (skills/instructions carry none post-redaction).
export const a2aAgentCard = (gem: Gem): Record<string, unknown> => {
  const skills = gem.artifacts.filter((a): a is SkillArtifact => a.type === "skill");
  const instr = gem.artifacts.filter((a): a is InstructionsArtifact => a.type === "instructions");
  const cardSkills = skills.map(a2aSkillCard);
  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: gem.name,
    description: a2aFirstLine(instr[0]?.content ?? "") || `An agent packaged by AgentGem from ${skills.length} skill(s).`,
    version: "0.1.0",
    // Non-resolving placeholder (RFC 6761 reserved TLD): a published card must NOT carry a localhost url
    // a consumer would dial against its own machine. Server mode rebinds this from PUBLIC_URL at boot.
    url: "https://set-public-url.invalid/a2a/jsonrpc",
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    skills: cardSkills.length ? cardSkills
      : [{ id: "chat", name: "chat", description: `Converse with ${gem.name}.`, tags: ["chat"] }],
  };
};

// ── A2A server mode (opt-in via MaterializeOpts.a2aServer) ──
// Runtime is Vercel AI SDK v7 (`ai` + `@ai-sdk/mcp`), vendor-neutral via the gateway model string —
// deliberately NOT @openai/agents, so sandboxMcpServer is not reused (a2aMcpClient is its analogue).
const A2A_MODEL = "anthropic/claude-sonnet-4-6";

// One AI SDK MCP client per server. http/sse -> { type, url, headers } (secret header values from env
// NAMES); stdio -> Experimental_StdioMCPTransport (command/args + secrets as env). Skip rules mirror
// sandboxMcpServer: http/sse map only headers.* secrets; stdio maps secrets to env; url-less non-stdio skipped.
type A2AClient = { code: string; stdio: boolean } | { skip: string };
const a2aMcpClient = (s: McpServerArtifact): A2AClient => {
  const url = typeof s.config.url === "string" ? s.config.url : "";
  if (/^https?:\/\//.test(url)) {
    const refs = s.secretRefs ?? [];
    const unsupported = refs.find((r) => !/^headers\./i.test(r.location));
    if (unsupported) return { skip: `A2A (AI SDK) cannot map secret at ${unsupported.location}` };
    const headerEntries = headerSecretEntries(refs);
    const headers = headerEntries.length
      ? `, headers: { ${headerEntries.map(([h, e]) => `${JSON.stringify(h)}: process.env[${JSON.stringify(e)}]!`).join(", ")} }`
      : "";
    const type = s.transport === "sse" ? "sse" : "http";
    return { code: `  createMCPClient({ transport: { type: ${JSON.stringify(type)}, url: ${JSON.stringify(url)}${headers} } }),`, stdio: false };
  }
  if (s.transport === "stdio" && typeof s.config.command === "string") {
    const args = Array.isArray(s.config.args) ? s.config.args.filter((a): a is string => typeof a === "string") : [];
    const envNames = (s.secretRefs ?? []).map((r) => r.name);
    const envStr = envNames.length ? `, env: { ${envNames.map((n) => `${JSON.stringify(n)}: process.env[${JSON.stringify(n)}]!`).join(", ")} }` : "";
    return { code: `  createMCPClient({ transport: new Experimental_StdioMCPTransport({ command: ${JSON.stringify(s.config.command)}, args: ${JSON.stringify(args)}${envStr} }) }),`, stdio: true };
  }
  return { skip: `${s.transport} MCP has no usable URL or stdio command` };
};

// A2A projects authenticate via plain process.env. Deliberately NOT agentcoreSecretsMd (its
// `agentcore add credential` / ${arn:...} body is wrong for an A2A/AI-SDK project).
const a2aSecretsMd = (secrets: SecretRequirement[]): string => {
  const model = `## Model access\n\nThe agent calls \`${A2A_MODEL}\` via the AI SDK. Set \`AI_GATEWAY_API_KEY\` ` +
    `(Vercel AI Gateway) or a direct provider key (e.g. \`ANTHROPIC_API_KEY\`).\n`;
  const access = `## Access control (optional)\n\nSet \`A2A_API_KEY\` to require \`Authorization: Bearer <key>\` on the ` +
    `agent's JSON-RPC/REST routes. Agent Card discovery (the \`.well-known\` endpoint) stays open.\n`;
  const mcp = secrets.length
    ? `## MCP credentials\n\nSet these before \`npm start\` (e.g. a \`.env\` file):\n\n` +
      `${secrets.map((s) => `- \`${s.name}\` (for ${s.artifact} at ${s.location})`).join("\n")}\n`
    : `## MCP credentials\n\nThis agent declares no MCP secrets.\n`;
  return `# Secrets\n\n${model}\n${access}\n${mcp}`;
};

const a2aPackageJson = (gemName: string): string => JSON.stringify({
  name: safePathSegment(gemName).toLowerCase(), version: "0.1.0", private: true, type: "module",
  scripts: { build: "tsc", start: "node dist/server.js", dev: "tsx src/server.ts" },
  // Verified pins: ai v7 beta pairs with @ai-sdk/mcp v2 beta; @a2a-js/sdk 0.3.x.
  dependencies: { "@a2a-js/sdk": "^0.3.13", ai: "7.0.0-beta.178", "@ai-sdk/mcp": "2.0.0-beta.67", express: "^5", uuid: "^11" },
  devDependencies: { "@types/express": "^5", "@types/node": "^24", tsx: "^4", typescript: "^5" },
}, null, 2) + "\n";

// The runnable A2A server: an AI SDK `streamText` tool loop behind the @a2a-js/sdk JSON-RPC handler.
// Streams incrementally via the A2A task lifecycle (submitted -> working -> artifact-update* ->
// completed); the same executor serves message/send (aggregated) and message/stream (SSE). The served
// card advertises streaming: true and rebinds `url` from PUBLIC_URL (the static card carries neither).
const a2aServerTs = (system: string, clientCodes: string[], usesStdio: boolean): string => {
  const mcpImports = clientCodes.length
    ? `import { createMCPClient } from "@ai-sdk/mcp";\n${usesStdio ? `import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";\n` : ""}`
    : "";
  const bootBlock = clientCodes.length
    ? `const mcpClients = await Promise.all([\n${clientCodes.join("\n")}\n]);
const tools = Object.assign({}, ...(await Promise.all(mcpClients.map((c) => c.tools()))));
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => { Promise.allSettled(mcpClients.map((c) => c.close())).finally(() => process.exit(0)); });`
    : `const tools = {};`;
  return `import express from "express";
import { streamText, stepCountIs } from "ai";
${mcpImports}import { type AgentCard, AGENT_CARD_PATH } from "@a2a-js/sdk";
import { type AgentExecutor, type RequestContext, type ExecutionEventBus,
  DefaultRequestHandler, InMemoryTaskStore, InMemoryPushNotificationStore, DefaultPushNotificationSender } from "@a2a-js/sdk/server";
import { agentCardHandler, jsonRpcHandler, restHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import { v4 as uuid } from "uuid";
import cardBase from "../agent-card.json" with { type: "json" };

const MODEL = ${JSON.stringify(A2A_MODEL)};
const SYSTEM = \`${escapeTemplate(system)}\`;

const port = Number(process.env.PORT ?? 41241);
const baseUrl = process.env.PUBLIC_URL ?? \`http://localhost:\${port}\`;
const API_KEY = process.env.A2A_API_KEY; // when set, require \`Authorization: Bearer <key>\` on the RPC/REST routes
const card: AgentCard = { ...(cardBase as AgentCard), url: \`\${baseUrl}/a2a/jsonrpc\`,
  capabilities: { ...(cardBase as AgentCard).capabilities, streaming: true, pushNotifications: true },
  additionalInterfaces: [
    { url: \`\${baseUrl}/a2a/jsonrpc\`, transport: "JSONRPC" },
    { url: \`\${baseUrl}/a2a/rest\`, transport: "HTTP+JSON" },
  ],
  ...(API_KEY ? { securitySchemes: { bearer: { type: "http", scheme: "bearer" } }, security: [{ bearer: [] }] } : {}) };

${bootBlock}

// Streaming executor: drive the tool loop and publish A2A task-lifecycle + artifact-update events.
class GemExecutor implements AgentExecutor {
  private inflight = new Map<string, AbortController>();
  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage, task } = ctx;
    const text = (userMessage.parts ?? []).filter((p: any) => p.kind === "text").map((p: any) => p.text).join("\\n").trim();
    // Guard: an A2A message may carry no text parts (file/data only). streamText rejects an empty
    // prompt, so reply directly instead of failing the request.
    if (!text) {
      bus.publish({ kind: "message", messageId: uuid(), role: "agent", contextId,
        parts: [{ kind: "text", text: "Please include a text message for the agent." }] });
      bus.finished();
      return;
    }
    const ac = new AbortController();
    this.inflight.set(taskId, ac);
    if (!task) bus.publish({ kind: "task", id: taskId, contextId, status: { state: "submitted", timestamp: new Date().toISOString() }, history: [userMessage] });
    bus.publish({ kind: "status-update", taskId, contextId, status: { state: "working", timestamp: new Date().toISOString() }, final: false });
    const artifactId = uuid();
    let started = false;
    try {
      const result = streamText({ model: MODEL, system: SYSTEM, tools, stopWhen: stepCountIs(10), prompt: text, abortSignal: ac.signal });
      for await (const delta of result.textStream) {
        bus.publish({ kind: "artifact-update", taskId, contextId, append: started, lastChunk: false,
          artifact: { artifactId, name: "response", parts: [{ kind: "text", text: delta }] } });
        started = true;
      }
      // Only close an artifact that was actually opened (empty/tool-only completions stream nothing).
      if (started) bus.publish({ kind: "artifact-update", taskId, contextId, append: true, lastChunk: true, artifact: { artifactId, parts: [] } });
      bus.publish({ kind: "status-update", taskId, contextId, status: { state: "completed", timestamp: new Date().toISOString() }, final: true });
    } catch (err) {
      const state = ac.signal.aborted ? "canceled" : "failed";
      bus.publish({ kind: "status-update", taskId, contextId, status: { state, timestamp: new Date().toISOString() }, final: true });
    } finally {
      this.inflight.delete(taskId);
      bus.finished();
    }
  }
  cancelTask = async (taskId: string): Promise<void> => { this.inflight.get(taskId)?.abort(); };
}

const pushStore = new InMemoryPushNotificationStore();
const requestHandler = new DefaultRequestHandler(card, new InMemoryTaskStore(), new GemExecutor(),
  undefined, pushStore, new DefaultPushNotificationSender(pushStore));
const app = express();
// Discovery (the /.well-known Agent Card) stays open; gate only the invocation routes when A2A_API_KEY is set.
const requireAuth: express.RequestHandler = (req, res, next) => {
  if (!API_KEY || req.headers.authorization === \`Bearer \${API_KEY}\`) return next();
  res.status(401).json({ error: "unauthorized" });
};
app.use("/a2a", requireAuth);
app.use(\`/\${AGENT_CARD_PATH}\`, agentCardHandler({ agentCardProvider: requestHandler }));
app.use("/a2a/jsonrpc", jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
app.use("/a2a/rest", restHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
app.listen(port, () => console.log(\`A2A agent "\${card.name}" listening on :\${port}\`));
`;
};

// A2A is wholly compose-driven: per-type renderers are no-ops (so materialize never auto-skip-reports),
// and compose owns ALL skip reporting for both modes. Hooks are never expressible by A2A (card or
// server). MCP is not expressible by a *Card* (card-only -> all MCP skipped), but the *server* wires it
// (server mode -> only unmappable MCP skipped). This keeps compatibility() honest: card-only reflects
// that a Card carries identity + skills, not MCP/hooks, instead of over-claiming full support.
const a2aComposeProject = (gem: Gem, opts: MaterializeOpts = {}): MaterializeResult => {
  const files: FileTree = { "agent-card.json": JSON.stringify(a2aAgentCard(gem), null, 2) + "\n" };
  const mcps  = gem.artifacts.filter((a): a is McpServerArtifact => a.type === "mcp_server");
  const hooks = gem.artifacts.filter((a): a is HookArtifact => a.type === "hook");
  const hookSkips = hooks.map((h): SkippedArtifact => ({ artifact: h.name, type: "hook", reason: "A2A has no hook concept" }));

  if (!opts.a2aServer) {
    // Card-only: an Agent Card represents identity + skills, not MCP servers or hooks.
    const cardSkips = mcps.map((s): SkippedArtifact => ({ artifact: s.name, type: "mcp_server", reason: "an Agent Card cannot express MCP servers (materialize with a2aServer to wire them)" }));
    return { files, skipped: [...cardSkips, ...hookSkips] };
  }

  const skills = gem.artifacts.filter((a): a is SkillArtifact => a.type === "skill");
  const instr  = gem.artifacts.filter((a): a is InstructionsArtifact => a.type === "instructions");

  // AI SDK has no skills primitive -> fold skill bodies (frontmatter-stripped) into the system prompt.
  const instrText = instr.map((i) => `## ${i.name}\n\n${i.content}`).join("\n\n---\n\n");
  const skillText = skills.map((s) => `## Skill: ${s.name}\n\n${stripYamlFrontmatter(s.content)}`).join("\n\n---\n\n");
  const system = [instrText, skillText].filter(Boolean).join("\n\n---\n\n");

  // Server mode: the server wires MCP, so only UNMAPPABLE MCP is skipped; hooks remain unsupported.
  const skipped: SkippedArtifact[] = [...hookSkips];
  const clientCodes: string[] = [];
  let usesStdio = false;
  for (const s of mcps) {
    const r = a2aMcpClient(s);
    if ("skip" in r) { skipped.push({ artifact: s.name, type: "mcp_server", reason: r.skip }); continue; }
    clientCodes.push(r.code); usesStdio ||= r.stdio;
  }

  return {
    files: {
      ...files,
      "src/server.ts": a2aServerTs(system, clientCodes, usesStdio),
      "package.json": a2aPackageJson(gem.name),
      "SECRETS.md": a2aSecretsMd(gem.requiredSecrets),
    },
    skipped,
  };
};

// ── targets compose the shared renderers (convergence is literal, not duplicated) ──
export const TARGET_REGISTRY: Record<TargetId, TargetSpec> = {
  claude: { id: "claude", label: "Claude", skill: skillSkillMd,       instructions: instructionsClaudeMd, mcp: mcpDotMcpJson, hook: hooksSettingsJson },
  codex:  { id: "codex",  label: "Codex",  skill: skillSkillMd,       instructions: instructionsAgentsMd, mcp: mcpCodexToml },
  agents: { id: "agents", label: "Agents", skill: skillSkillMd,       instructions: instructionsAgentsMd },
  hermes: { id: "hermes", label: "Hermes", skill: skillDescriptionMd, instructions: instructionsSoulMd },
  // Eve project layout (agent/...). Hooks are event-reacting code in Eve, not config -> unsupported.
  eve:    { id: "eve",    label: "Eve",    skill: skillEveMd,         instructions: concatInstructions("agent/instructions.md"), mcp: mcpEveConnections, channel: channelEve, compose: eveComposeProject },
  // Flue project layout. Skills reuse SKILL.md; instructions fold into the composed agent file (no
  // standalone file -> the empty instructions renderer marks them handled, not skipped). MCP added in Task 2.
  flue:   { id: "flue",   label: "Flue",   skill: skillFlueMd,        instructions: () => ({}), mcp: mcpFlueConnections, compose: flueComposeAgent },
  // OpenAI Agents SDK SandboxAgent (single <gemname>.agent.ts). Skills reuse SKILL.md (seeded via the
  // Manifest); instructions fold into the agent file. MCP is added inline in Task 2 (mcp renderer + compose).
  "openai-sandbox": { id: "openai-sandbox", label: "OpenAI Sandbox", skill: skillSkillMd, instructions: () => ({}), mcp: () => ({ files: {}, skipped: [] }), compose: sandboxComposeAgent },
  // AgentCore harness project (app/<gem>/harness.json + container-baked skills). Instructions/MCP
  // fold into the composed harness.json; stdio MCP is reported skipped by compose; hooks unsupported.
  agentcore: { id: "agentcore", label: "AgentCore", skill: skillAgentcoreMd, instructions: () => ({}), mcp: () => ({ files: {}, skipped: [] }), compose: agentcoreComposeProject },
  // A2A Agent Card primitive. Wholly compose-driven (all per-type renderers no-op); compose emits the
  // runtime-free agent-card.json. Card-only mode reports nothing skipped.
  a2a: { id: "a2a", label: "A2A", skill: () => ({}), instructions: () => ({}), mcp: () => ({ files: {}, skipped: [] }), hook: () => ({}), compose: a2aComposeProject },
};

export function materialize(gem: Gem, target: TargetId, opts: MaterializeOpts = {}): MaterializeResult {
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

  const skills = gem.artifacts.filter((a): a is SkillArtifact => a.type === "skill");
  const mcp = gem.artifacts.filter((a): a is McpServerArtifact => a.type === "mcp_server");
  const instr = gem.artifacts.filter((a): a is InstructionsArtifact => a.type === "instructions");
  const hooks = gem.artifacts.filter((a): a is HookArtifact => a.type === "hook");
  const channels = gem.artifacts.filter((a): a is ChannelArtifact => a.type === "channel");

  if (spec.skill) for (const s of skills) merge(spec.skill(s), s.name, "skill");
  else skipAll(skills, "skill");

  if (instr.length) {
    if (spec.instructions) merge(spec.instructions(instr), instr.map((i) => i.name).join(", "), "instructions");
    else skipAll(instr, "instructions");
  }
  if (mcp.length) {
    if (spec.mcp) {
      const result = spec.mcp(mcp);
      merge(result.files, mcp.map((m) => m.name).join(", "), "mcp_server");
      skipped.push(...result.skipped);
    }
    else skipAll(mcp, "mcp_server");
  }
  if (hooks.length) {
    if (spec.hook) merge(spec.hook(hooks), hooks.map((h) => h.name).join(", "), "hook");
    else skipAll(hooks, "hook");
  }
  if (channels.length) {
    if (spec.channel) {
      const result = spec.channel(channels);
      merge(result.files, channels.map((c) => c.name).join(", "), "channel");
      skipped.push(...result.skipped);
    }
    else skipAll(channels, "channel");
  }

  if (spec.compose) {
    const result = spec.compose(gem, opts);
    merge(result.files, "(composed agent)", "instructions"); // collisions reported; agent file derives from instructions+skills
    skipped.push(...result.skipped);
  }

  return { files, skipped };
}

export function compatibility(gem: Gem): Record<TargetId, { supported: number; skipped: number }> {
  const out = {} as Record<TargetId, { supported: number; skipped: number }>;
  for (const id of Object.keys(TARGET_REGISTRY) as TargetId[]) {
    const r = materialize(gem, id);
    out[id] = { supported: gem.artifacts.length - r.skipped.length, skipped: r.skipped.length };
  }
  return out;
}
