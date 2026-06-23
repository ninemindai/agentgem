// src/gem/targets.ts
// Render a normalized Gem INTO a harness's on-disk layout. Pure; writes nothing — returns an
// in-memory FileTree. Targets compose shared per-artifact-type convention renderers; unmappable
// artifacts are skipped with a reason. Materialize re-renders an already-redacted Gem; the
// runner rebinds real secrets from gem.requiredSecrets at install.
import type {
  Gem, ArtifactType, SecretRequirement,
  SkillArtifact, McpServerArtifact, InstructionsArtifact, HookArtifact,
} from "./types.js";
import { tomlMcpServers } from "./toml.js";
import { stdioProxyRunner, PROXY_BASE_PORT, PROXY_HOST } from "./mcpProxy.js";

export type TargetId = "claude" | "codex" | "agents" | "hermes" | "eve" | "flue" | "openai-sandbox" | "agentcore";
export type FileTree = Record<string, string>;

export interface SkippedArtifact { artifact: string; type: ArtifactType; reason: string }
export interface MaterializeResult { files: FileTree; skipped: SkippedArtifact[] }

// Per-materialization options that some targets honor (e.g. eve's deploy-time auth posture).
export interface MaterializeOpts { eveAuth?: "placeholder" | "public" }

interface TargetSpec {
  id: TargetId;
  label: string;
  skill?: (a: SkillArtifact) => FileTree;
  mcp?: (servers: McpServerArtifact[]) => MaterializeResult;
  instructions?: (all: InstructionsArtifact[]) => FileTree;
  hook?: (hooks: HookArtifact[]) => FileTree;
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
// PascalCase of the kebab name; flue derives the Durable Object class as `Flue<Pascal>Agent`.
const fluePascal = (name: string): string =>
  flueName(name).split("-").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join("") || "Agent";
// Flue skills live under src/ (the agent file is src/agents/<name>.ts and imports ../skills/...).
const skillFlueMd = (a: SkillArtifact): FileTree => ({ [`src/skills/${safePathSegment(a.name)}/SKILL.md`]: a.content });

const rendered = (files: FileTree): MaterializeResult => ({ files, skipped: [] });

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
  const refs = server.secretRefs ?? [];
  const authorization = refs.find((r) => r.location.toLowerCase() === "headers.authorization");
  const headerEntries: (readonly [string, string])[] = [
    ...(authorization ? [["Authorization", authorization.name] as const] : []),
    ...refs.filter((r) => /^headers\./i.test(r.location) && r !== authorization)
          .map((r) => [r.location.slice("headers.".length), r.name] as const),
  ];
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
  const wname = flueName(gem.name);
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
    const authorization = refs.find((r) => r.location.toLowerCase() === "headers.authorization");
    const headerEntries: (readonly [string, string])[] = [
      ...(authorization ? [["Authorization", authorization.name] as const] : []),
      ...refs.filter((r) => /^headers\./i.test(r.location) && r !== authorization).map((r) => [r.location.slice("headers.".length), r.name] as const),
    ];
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

// ── targets compose the shared renderers (convergence is literal, not duplicated) ──
export const TARGET_REGISTRY: Record<TargetId, TargetSpec> = {
  claude: { id: "claude", label: "Claude", skill: skillSkillMd,       instructions: instructionsClaudeMd, mcp: mcpDotMcpJson, hook: hooksSettingsJson },
  codex:  { id: "codex",  label: "Codex",  skill: skillSkillMd,       instructions: instructionsAgentsMd, mcp: mcpCodexToml },
  agents: { id: "agents", label: "Agents", skill: skillSkillMd,       instructions: instructionsAgentsMd },
  hermes: { id: "hermes", label: "Hermes", skill: skillDescriptionMd, instructions: instructionsSoulMd },
  // Eve project layout (agent/...). Hooks are event-reacting code in Eve, not config -> unsupported.
  eve:    { id: "eve",    label: "Eve",    skill: skillEveMd,         instructions: concatInstructions("agent/instructions.md"), mcp: mcpEveConnections, compose: eveComposeProject },
  // Flue project layout. Skills reuse SKILL.md; instructions fold into the composed agent file (no
  // standalone file -> the empty instructions renderer marks them handled, not skipped). MCP added in Task 2.
  flue:   { id: "flue",   label: "Flue",   skill: skillFlueMd,        instructions: () => ({}), mcp: mcpFlueConnections, compose: flueComposeAgent },
  // OpenAI Agents SDK SandboxAgent (single <gemname>.agent.ts). Skills reuse SKILL.md (seeded via the
  // Manifest); instructions fold into the agent file. MCP is added inline in Task 2 (mcp renderer + compose).
  "openai-sandbox": { id: "openai-sandbox", label: "OpenAI Sandbox", skill: skillSkillMd, instructions: () => ({}), mcp: () => ({ files: {}, skipped: [] }), compose: sandboxComposeAgent },
  // AgentCore harness project (app/<gem>/harness.json + container-baked skills). Instructions/MCP
  // fold into the composed harness.json; stdio MCP is reported skipped by compose; hooks unsupported.
  agentcore: { id: "agentcore", label: "AgentCore", skill: skillAgentcoreMd, instructions: () => ({}), mcp: () => ({ files: {}, skipped: [] }), compose: agentcoreComposeProject },
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
