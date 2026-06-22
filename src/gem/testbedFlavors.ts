// src/gem/testbedFlavors.ts
// The set of harness "flavors" a testbed can be authored/test-driven as. Flavors drive the
// flavor-specific bits — detection, scaffold skeleton, test-drive run command, and import support.
// Introspection is flavor-agnostic (introspectProject reads whatever project config is present).
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseTomlMcpServers, tomlMcpServers } from "./toml.js";
import type { McpServerArtifact } from "./types.js";

export type TestbedFlavorId = "claude" | "codex" | "hermes";

export interface FlavorImport {
  skillRel(name: string): string;
  instructionsFile: string;
  writeMcp?: (root: string, name: string, rawConfig: Record<string, unknown>) => boolean;
  supportsHooks: boolean;
}

export interface TestbedFlavor {
  id: TestbedFlavorId;
  label: string;
  detect(root: string): boolean;
  scaffold(root: string, name: string): { created: string[] };
  runCommand: string;
  importSupported: boolean;
  import: FlavorImport;
}

function writeIfAbsent(root: string, rel: string, content: string, created: string[]): void {
  const abs = join(root, rel);
  if (existsSync(abs)) return;
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  created.push(rel);
}

// Remove every [mcp_servers...] section (header through to the next top-level table or EOF),
// preserving all other content. Lets writeMcpCodexToml regenerate just the MCP block.
function stripMcpServerBlocks(toml: string): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of toml.split("\n")) {
    if (/^\s*\[/.test(line)) skipping = /^\s*\[mcp_servers(\.|\])/.test(line); // a table header (re)sets the mode
    if (!skipping) out.push(line);
  }
  return out.join("\n");
}

export function writeMcpCodexToml(root: string, name: string, rawConfig: Record<string, unknown>): boolean {
  const abs = join(root, ".codex", "config.toml");
  const text = existsSync(abs) ? readFileSync(abs, "utf8") : "";
  const servers = parseTomlMcpServers(text);
  const overwritten = name in servers;
  servers[name] = rawConfig;                      // raw config — local testbed only
  const nonMcp = stripMcpServerBlocks(text).trimEnd();
  const arts = Object.entries(servers).map(([n, config]) =>
    ({ type: "mcp_server", name: n, transport: "stdio", config } as McpServerArtifact));
  const block = tomlMcpServers(arts);            // regenerated [mcp_servers...] section
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, (nonMcp ? nonMcp + "\n\n" : "") + block, "utf8");
  return overwritten;
}

function readJsonFile(abs: string): Record<string, unknown> {
  try { const v = JSON.parse(readFileSync(abs, "utf8")); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; }
  catch { return {}; }
}

export function writeMcpJson(root: string, name: string, rawConfig: Record<string, unknown>): boolean {
  const abs = join(root, ".mcp.json");
  const doc = readJsonFile(abs);
  const servers = (doc.mcpServers && typeof doc.mcpServers === "object" ? doc.mcpServers : {}) as Record<string, unknown>;
  const overwritten = name in servers;
  servers[name] = rawConfig;                       // raw config — local testbed only
  doc.mcpServers = servers;
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(doc, null, 2) + "\n", "utf8");
  return overwritten;
}

export const TESTBED_FLAVORS: Record<TestbedFlavorId, TestbedFlavor> = {
  claude: {
    id: "claude", label: "Claude Code", runCommand: "claude", importSupported: true,
    detect: (root) => existsSync(join(root, ".claude")) || existsSync(join(root, "CLAUDE.md")),
    scaffold: (root, name) => {
      const created: string[] = [];
      mkdirSync(join(root, ".claude", "skills"), { recursive: true });
      writeIfAbsent(root, ".claude/settings.json", "{}\n", created);
      writeIfAbsent(root, "CLAUDE.md", `# ${name}\n`, created);
      writeIfAbsent(root, ".gitignore", ".mcp.json\n.claude/settings.json\n.env\n.targets/\n", created);
      return { created };
    },
    import: { skillRel: (n) => `.claude/skills/${n}/SKILL.md`, instructionsFile: "CLAUDE.md", writeMcp: writeMcpJson, supportsHooks: true },
  },
  codex: {
    id: "codex", label: "Codex", runCommand: "codex", importSupported: true,
    detect: (root) => existsSync(join(root, ".codex")) || existsSync(join(root, "AGENTS.md")),
    scaffold: (root, name) => {
      const created: string[] = [];
      mkdirSync(join(root, ".agents", "skills"), { recursive: true });
      writeIfAbsent(root, "AGENTS.md", `# ${name}\n`, created);
      writeIfAbsent(root, ".gitignore", ".codex/config.toml\n.env\n.targets/\n", created);
      return { created };
    },
    import: { skillRel: (n) => `.agents/skills/${n}/SKILL.md`, instructionsFile: "AGENTS.md", writeMcp: writeMcpCodexToml, supportsHooks: false },
  },
  hermes: {
    id: "hermes", label: "Hermes", runCommand: "hermes", importSupported: true,
    detect: (root) => existsSync(join(root, ".hermes")),
    scaffold: (root, name) => {
      const created: string[] = [];
      mkdirSync(join(root, ".hermes", "skills"), { recursive: true });
      writeIfAbsent(root, ".hermes/SOUL.md", `# ${name}\n`, created);
      writeIfAbsent(root, ".gitignore", ".hermes/config.yaml\n.env\n.targets/\n", created);
      return { created };
    },
    import: { skillRel: (n) => `.hermes/skills/${n}/DESCRIPTION.md`, instructionsFile: ".hermes/SOUL.md", writeMcp: undefined, supportsHooks: false },
  },
};

export function flavorIds(): TestbedFlavorId[] {
  return Object.keys(TESTBED_FLAVORS) as TestbedFlavorId[];
}

// Single marker match -> that flavor; none or several -> null (caller asks).
export function detectFlavor(root: string): TestbedFlavorId | null {
  const hits = flavorIds().filter((id) => TESTBED_FLAVORS[id].detect(root));
  return hits.length === 1 ? hits[0] : null;
}
