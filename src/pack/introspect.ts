// src/pack/introspect.ts
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { redactMcpConfig } from "./redact.js";
import type {
  ConfigInventory,
  ProjectInventory,
  SkillArtifact,
  McpServerArtifact,
  InstructionsArtifact,
  HookArtifact,
} from "./types.js";

export interface IntrospectOptions {
  claudeDir?: string;
  agentDir?: string;
  codexDir?: string;
  hermesDir?: string;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function parseFrontmatter(content: string): { description?: string; internal: boolean } {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return { internal: false };
  const fm = m[1];
  const description = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  const internal = /^\s*internal:\s*true\s*$/m.test(fm);
  return { description, internal };
}

function inferTransport(config: Record<string, unknown>): "stdio" | "http" | "sse" {
  if (typeof config.url === "string") return config.type === "sse" ? "sse" : "http";
  return "stdio";
}

// Read <skillsRoot>/<name>/<file> skills. `files` lists the candidate body filenames to try
// in order (Claude/Codex/Agents use SKILL.md; Hermes uses DESCRIPTION.md).
function readSkillsDir(skillsRoot: string, source: string, files: string[] = ["SKILL.md"]): SkillArtifact[] {
  const out: SkillArtifact[] = [];
  if (!existsSync(skillsRoot)) return out;
  let names: string[];
  try {
    names = readdirSync(skillsRoot);
  } catch {
    return out;
  }
  for (const name of names) {
    const skillMd = files.map((f) => join(skillsRoot, name, f)).find((p) => existsSync(p));
    if (!skillMd) continue;
    try {
      const content = readFileSync(skillMd, "utf8");
      const { description, internal } = parseFrontmatter(content);
      if (internal) continue;
      out.push({ type: "skill", name, description, source, content });
    } catch {
      // skip unreadable skill
    }
  }
  return out;
}

// Read each file directly under <rulesRoot> as an instructions artifact (Codex keeps its
// global instructions as rules files, e.g. ~/.codex/rules/default.rules).
function readRulesDir(rulesRoot: string): InstructionsArtifact[] {
  const out: InstructionsArtifact[] = [];
  if (!existsSync(rulesRoot)) return out;
  let names: string[];
  try {
    names = readdirSync(rulesRoot);
  } catch {
    return out;
  }
  for (const file of names) {
    try {
      out.push({ type: "instructions", name: `codex:rules/${file}`, content: readFileSync(join(rulesRoot, file), "utf8") });
    } catch {
      // skip subdirectories / unreadable files
    }
  }
  return out;
}

function serversToArtifacts(servers: Record<string, unknown>, source: string): McpServerArtifact[] {
  return Object.entries(servers).map(([name, cfg]) => {
    const config = isObj(cfg) ? cfg : {};
    return { type: "mcp_server", name, transport: inferTransport(config), config: redactMcpConfig(config), source };
  });
}

function serversFromMcpJson(parsed: unknown): Record<string, unknown> {
  if (!isObj(parsed)) return {};
  if (isObj(parsed.mcpServers)) return parsed.mcpServers;
  return parsed;
}

// Turn a config's `.hooks` event map into per-(event, matcher) artifacts. Works for both
// settings.json (user/project) and a plugin's hooks/hooks.json — both nest under `.hooks`.
// Each group object is redacted (defense; near-no-op for command strings).
function hooksFromConfig(parsed: unknown, source: string): HookArtifact[] {
  const out: HookArtifact[] = [];
  if (!isObj(parsed) || !isObj(parsed.hooks)) return out;
  for (const [event, groups] of Object.entries(parsed.hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!isObj(g)) continue;
      const matcher = typeof g.matcher === "string" && g.matcher.length ? g.matcher : undefined;
      out.push({ type: "hook", name: `${event}${matcher ? ` · ${matcher}` : ""}`, event, matcher, config: redactMcpConfig(g), source });
    }
  }
  return out;
}

// Hooks are selected by name, so make names unique across sources: a collided name gets its
// source appended (and an index if the source collides too).
function uniqueHookNames(hooks: HookArtifact[]): HookArtifact[] {
  const counts: Record<string, number> = {};
  hooks.forEach((h) => (counts[h.name] = (counts[h.name] || 0) + 1));
  const idx: Record<string, number> = {};
  return hooks.map((h) => {
    if (counts[h.name] === 1) return h;
    idx[h.name] = (idx[h.name] || 0) + 1;
    return { ...h, name: `${h.name} (${h.source})${idx[h.name] > 1 ? ` #${idx[h.name]}` : ""}` };
  });
}

function dedupByName<T extends { name: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    if (seen.has(it.name)) continue;
    seen.add(it.name);
    out.push(it);
  }
  return out;
}

export function introspectConfig(opts: IntrospectOptions = {}): ConfigInventory {
  const claudeDir = opts.claudeDir ?? join(homedir(), ".claude");
  const agentDir = opts.agentDir ?? join(homedir(), ".agents", "skills");
  const codexDir = opts.codexDir ?? join(homedir(), ".codex");
  const hermesDir = opts.hermesDir ?? join(homedir(), ".hermes");

  const skillList: SkillArtifact[] = [];
  const mcpList: McpServerArtifact[] = [];
  const hookList: HookArtifact[] = [];

  skillList.push(...readSkillsDir(join(claudeDir, "skills"), "standalone"));

  const settings = readJson(join(claudeDir, "settings.json"));
  if (isObj(settings) && isObj(settings.mcpServers)) {
    mcpList.push(...serversToArtifacts(settings.mcpServers, "user"));
  }
  mcpList.push(...serversToArtifacts(serversFromMcpJson(readJson(join(claudeDir, ".mcp.json"))), "user"));
  hookList.push(...hooksFromConfig(settings, "user"));

  const enabled = isObj(settings) && isObj(settings.enabledPlugins) ? settings.enabledPlugins : {};
  const installed = readJson(join(claudeDir, "plugins", "installed_plugins.json"));
  const pluginsMap = isObj(installed) && isObj(installed.plugins) ? installed.plugins : {};
  for (const [key, entry] of Object.entries(pluginsMap)) {
    if (enabled[key] !== true) continue;
    const installPath = Array.isArray(entry) && isObj(entry[0]) ? (entry[0].installPath as string | undefined) : undefined;
    if (!installPath || typeof installPath !== "string") continue;
    const source = `plugin:${key}`;
    mcpList.push(...serversToArtifacts(serversFromMcpJson(readJson(join(installPath, ".mcp.json"))), source));
    skillList.push(...readSkillsDir(join(installPath, "skills"), source));
    hookList.push(...hooksFromConfig(readJson(join(installPath, "hooks", "hooks.json")), source));
  }

  skillList.push(...readSkillsDir(agentDir, "agent"));

  // Source 5: Codex skills (~/.codex/skills)
  skillList.push(...readSkillsDir(join(codexDir, "skills"), "codex"));

  // Source 6: Hermes skills (~/.hermes/skills/<name>/DESCRIPTION.md, some SKILL.md).
  // Hermes secrets (.env, auth.json, config.yaml) are never read.
  skillList.push(...readSkillsDir(join(hermesDir, "skills"), "hermes", ["SKILL.md", "DESCRIPTION.md"]));

  const instructions: InstructionsArtifact[] = [];
  const claudeMd = join(claudeDir, "CLAUDE.md");
  if (existsSync(claudeMd)) {
    try {
      instructions.push({ type: "instructions", name: "CLAUDE.md", content: readFileSync(claudeMd, "utf8") });
    } catch {
      // skip unreadable CLAUDE.md
    }
  }
  // Codex rules (~/.codex/rules/*) as instructions
  instructions.push(...readRulesDir(join(codexDir, "rules")));
  // Hermes persona (~/.hermes/SOUL.md) as instructions
  const soul = join(hermesDir, "SOUL.md");
  if (existsSync(soul)) {
    try {
      instructions.push({ type: "instructions", name: "SOUL.md", content: readFileSync(soul, "utf8") });
    } catch {
      // skip unreadable SOUL.md
    }
  }

  return { skills: dedupByName(skillList), mcpServers: dedupByName(mcpList), instructions, hooks: uniqueHookNames(hookList) };
}

// Discover PROJECT-level artifacts under a chosen project root, tagged source "project".
// Kept separate from the global inventory (its own group, its own selection namespace) so a
// project artifact never collides with a same-named global one.
export function introspectProject(root: string): ProjectInventory {
  const skills: SkillArtifact[] = [];
  const mcp: McpServerArtifact[] = [];
  const instructions: InstructionsArtifact[] = [];
  const hooks: HookArtifact[] = [];

  skills.push(...readSkillsDir(join(root, ".claude", "skills"), "project"));
  skills.push(...readSkillsDir(join(root, ".agents", "skills"), "project"));

  const settings = readJson(join(root, ".claude", "settings.json"));
  if (isObj(settings) && isObj(settings.mcpServers)) mcp.push(...serversToArtifacts(settings.mcpServers, "project"));
  mcp.push(...serversToArtifacts(serversFromMcpJson(readJson(join(root, ".mcp.json"))), "project"));
  hooks.push(...hooksFromConfig(settings, "project"));
  hooks.push(...hooksFromConfig(readJson(join(root, ".claude", "hooks", "hooks.json")), "project"));

  for (const file of ["CLAUDE.md", "AGENTS.md"]) {
    const p = join(root, file);
    if (existsSync(p)) {
      try {
        instructions.push({ type: "instructions", name: file, content: readFileSync(p, "utf8") });
      } catch {
        // skip unreadable instructions file
      }
    }
  }

  return { root, name: basename(root), skills: dedupByName(skills), mcpServers: dedupByName(mcp), instructions, hooks: uniqueHookNames(hooks) };
}
