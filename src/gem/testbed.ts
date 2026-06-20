// src/gem/testbed.ts
// The inverse of introspect.ts: scaffold a runnable .claude/ testbed and merge selected
// GLOBAL artifacts into it. MCP/hook secrets are copied verbatim from raw global config into
// the LOCAL testbed only (never into a Gem). Owns its own read-merge-write disk I/O.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

function writeIfAbsent(root: string, rel: string, content: string, created: string[]): void {
  const abs = join(root, rel);
  if (existsSync(abs)) return;
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  created.push(rel);
}

export function scaffoldTestbed(root: string, name: string): { root: string; created: string[] } {
  const created: string[] = [];
  mkdirSync(join(root, ".claude", "skills"), { recursive: true });
  writeIfAbsent(root, ".claude/settings.json", "{}\n", created);
  writeIfAbsent(root, "CLAUDE.md", `# ${name}\n`, created);
  writeIfAbsent(root, ".gitignore", ".mcp.json\n.claude/settings.json\n.env\n.targets/\n", created);
  return { root, created };
}
