// src/gem/testbed.ts
// The inverse of introspect.ts: scaffold a runnable .claude/ testbed and merge selected
// GLOBAL artifacts into it. MCP/hook secrets are copied verbatim from raw global config into
// the LOCAL testbed only (never into a Gem). Owns its own read-merge-write disk I/O.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ConfigInventory } from "./types.js";

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

export interface ImportedRef { type: "skill" | "mcp_server" | "instructions" | "hook"; name: string; overwritten: boolean }
export interface ImportSkip { artifact: string; reason: string }
export interface ImportSelection { skills?: string[]; mcpServers?: string[]; hooks?: string[]; includeInstructions?: boolean }

function marker(name: string): { open: string; close: string } {
  return { open: `<!-- agentgem:imported ${name} -->`, close: `<!-- /agentgem:end ${name} -->` };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Replace an existing marked block, else append one. Keeps re-import idempotent.
function upsertMarkedBlock(root: string, rel: string, name: string, content: string): void {
  const abs = join(root, rel);
  const existing = existsSync(abs) ? readFileSync(abs, "utf8") : "";
  const { open, close } = marker(name);
  const block = `${open}\n${content}\n${close}`;
  const re = new RegExp(`${escapeRegex(open)}[\\s\\S]*?${escapeRegex(close)}`);
  const next = re.test(existing) ? existing.replace(re, block) : `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${block}\n`;
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, next, "utf8");
}

export function importArtifacts(root: string, selection: ImportSelection, rawInv: ConfigInventory): { written: ImportedRef[]; skipped: ImportSkip[] } {
  const written: ImportedRef[] = [];
  const skipped: ImportSkip[] = [];

  for (const name of selection.skills ?? []) {
    const sk = rawInv.skills.find((s) => s.name === name);
    if (!sk) { skipped.push({ artifact: name, reason: "not found in global inventory" }); continue; }
    const rel = `.claude/skills/${name}/SKILL.md`;
    const overwritten = existsSync(join(root, rel));
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), sk.content, "utf8");
    written.push({ type: "skill", name, overwritten });
  }

  if (selection.includeInstructions) {
    for (const ins of rawInv.instructions) {
      upsertMarkedBlock(root, "CLAUDE.md", ins.name, ins.content);
      written.push({ type: "instructions", name: ins.name, overwritten: false });
    }
  }

  return { written, skipped };
}
