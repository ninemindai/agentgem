// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/testbed.ts
// The inverse of introspect.ts: scaffold a runnable .claude/ testbed and merge selected
// GLOBAL artifacts into it. MCP/hook secrets are copied verbatim from raw global config into
// the LOCAL testbed only (never into a Gem). Owns its own read-merge-write disk I/O.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ConfigInventory } from "@agentgem/model";
import { TESTBED_FLAVORS, type TestbedFlavorId } from "./testbedFlavors.js";

function readJson(abs: string): Record<string, unknown> {
  try { const v = JSON.parse(readFileSync(abs, "utf8")); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; }
  catch { return {}; }
}
function writeJson(abs: string, obj: unknown): void {
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

export function scaffoldTestbed(root: string, name: string, flavor: TestbedFlavorId = "claude"): { root: string; created: string[] } {
  const { created } = TESTBED_FLAVORS[flavor].scaffold(root, name);
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
// Returns true when an existing block was replaced (so the caller can report `overwritten`).
function upsertMarkedBlock(root: string, rel: string, name: string, content: string): boolean {
  const abs = join(root, rel);
  const existing = existsSync(abs) ? readFileSync(abs, "utf8") : "";
  const { open, close } = marker(name);
  const block = `${open}\n${content}\n${close}`;
  const re = new RegExp(`${escapeRegex(open)}[\\s\\S]*?${escapeRegex(close)}`);
  const replaced = re.test(existing);
  const next = replaced ? existing.replace(re, block) : `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${block}\n`;
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, next, "utf8");
  return replaced;
}

export function importArtifacts(root: string, selection: ImportSelection, rawInv: ConfigInventory, flavor: TestbedFlavorId = "claude"): { written: ImportedRef[]; skipped: ImportSkip[] } {
  const written: ImportedRef[] = [];
  const skipped: ImportSkip[] = [];
  const { import: imp, label } = TESTBED_FLAVORS[flavor];

  for (const name of selection.skills ?? []) {
    const sk = rawInv.skills.find((s) => s.name === name);
    if (!sk) { skipped.push({ artifact: name, reason: "not found in global inventory" }); continue; }
    const rel = imp.skillRel(name);
    const overwritten = existsSync(join(root, rel));
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), sk.content, "utf8");
    written.push({ type: "skill", name, overwritten });
  }

  if (selection.includeInstructions) {
    for (const ins of rawInv.instructions) {
      const overwritten = upsertMarkedBlock(root, imp.instructionsFile, ins.name, ins.content);
      written.push({ type: "instructions", name: ins.name, overwritten });
    }
  }

  for (const name of selection.mcpServers ?? []) {
    const m = rawInv.mcpServers.find((s) => s.name === name);
    if (!m) { skipped.push({ artifact: name, reason: "not found in global inventory" }); continue; }
    if (!imp.writeMcp) { skipped.push({ artifact: name, reason: `${label} has no MCP-server config` }); continue; }
    const overwritten = imp.writeMcp(root, name, m.config); // raw config — local testbed only
    written.push({ type: "mcp_server", name, overwritten });
  }

  for (const name of selection.hooks ?? []) {
    const h = rawInv.hooks.find((x) => x.name === name);
    if (!h) { skipped.push({ artifact: name, reason: "not found in global inventory" }); continue; }
    if (!imp.supportsHooks) { skipped.push({ artifact: name, reason: `${label} has no hooks` }); continue; }
    const abs = join(root, ".claude", "settings.json");
    const doc = readJson(abs);
    const hooks = (doc.hooks && typeof doc.hooks === "object" ? doc.hooks : {}) as Record<string, unknown[]>;
    const groups = Array.isArray(hooks[h.event]) ? hooks[h.event] : [];
    const exists = groups.some((g) => JSON.stringify(g) === JSON.stringify(h.config));
    if (!exists) groups.push(h.config);
    hooks[h.event] = groups;
    doc.hooks = hooks;
    writeJson(abs, doc);
    written.push({ type: "hook", name, overwritten: false });
  }

  return { written, skipped };
}
