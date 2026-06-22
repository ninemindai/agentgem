// src/gem/testbedFlavors.ts
// The set of harness "flavors" a testbed can be authored/test-driven as. Flavors drive the
// flavor-specific bits — detection, scaffold skeleton, test-drive run command, and import support.
// Introspection is flavor-agnostic (introspectProject reads whatever project config is present).
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseTomlMcpServers, tomlMcpServers } from "./toml.js";
import type { McpServerArtifact } from "./types.js";

export type TestbedFlavorId = "claude" | "codex" | "hermes";

export interface TestbedFlavor {
  id: TestbedFlavorId;
  label: string;
  detect(root: string): boolean;
  scaffold(root: string, name: string): { created: string[] };
  runCommand: string;
  importSupported: boolean;
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
  },
  codex: {
    id: "codex", label: "Codex", runCommand: "codex", importSupported: false,
    detect: (root) => existsSync(join(root, ".codex")) || existsSync(join(root, "AGENTS.md")),
    scaffold: (root, name) => {
      const created: string[] = [];
      mkdirSync(join(root, ".agents", "skills"), { recursive: true });
      writeIfAbsent(root, "AGENTS.md", `# ${name}\n`, created);
      writeIfAbsent(root, ".gitignore", ".codex/config.toml\n.env\n.targets/\n", created);
      return { created };
    },
  },
  hermes: {
    id: "hermes", label: "Hermes", runCommand: "hermes", importSupported: false,
    detect: (root) => existsSync(join(root, ".hermes")),
    scaffold: (root, name) => {
      const created: string[] = [];
      mkdirSync(join(root, ".hermes", "skills"), { recursive: true });
      writeIfAbsent(root, ".hermes/SOUL.md", `# ${name}\n`, created);
      writeIfAbsent(root, ".gitignore", ".hermes/config.yaml\n.env\n.targets/\n", created);
      return { created };
    },
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
