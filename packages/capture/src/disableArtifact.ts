// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/capture/src/disableArtifact.ts
//
// Reversible deactivation — the write-twin of introspect.ts. Every operation is
// undoable: skills and settings.json MCP relocate into <base>/.agentgem/disabled/
// (the archive path encodes provenance), while plugins and .mcp.json MCP flip a flag.
// Never throws: each item degrades to { ok:false, message }, matching installSkill.
import { existsSync, mkdirSync, renameSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { agentgemHome } from "@agentgem/model";
import { SKILL_SOURCES, resolveSkillRoot, type SkillSource } from "./skillRoots.js";

export type ArtifactType = "skill" | "mcp" | "plugin";
export interface DisableOptions { claudeDir?: string; agentDir?: string; codexDir?: string; hermesDir?: string }
export interface DisableItem { type: ArtifactType; name: string; source: string }
export interface DisableResult { type: ArtifactType; name: string; ok: boolean; message: string }
export interface DisabledArtifact { type: ArtifactType; name: string; source: string }

const NAME_RE = /^[\w.@-]+$/;       // skill/mcp/plugin identifiers
const SOURCE_RE = /^[\w.:@/-]+$/;   // "standalone", "user", "plugin:brooks-lint"

function invalid(name: string, source: string): boolean {
  return !NAME_RE.test(name) || !SOURCE_RE.test(source) || name.includes("..") || source.includes("..");
}
function readJson(path: string): any {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}
function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}
// Base for the archive mirrors introspect.ts's distilled-base rule so a claudeDir
// override (tests) keeps everything self-contained under one temp home.
function archiveRoot(opts: DisableOptions): string {
  const base = opts.claudeDir ? dirname(opts.claudeDir) : agentgemHome();
  return join(base, ".agentgem", "disabled");
}
function claudeConfigDir(opts: DisableOptions): string {
  return opts.claudeDir ?? join(homedir(), ".claude");
}
function settingsPath(opts: DisableOptions): string {
  return join(claudeConfigDir(opts), "settings.json");
}

export function disableArtifacts(items: DisableItem[], opts: DisableOptions = {}): DisableResult[] {
  return items.map((it) => disableOne(it, opts));
}
export function enableArtifacts(items: DisableItem[], opts: DisableOptions = {}): DisableResult[] {
  return items.map((it) => enableOne(it, opts));
}

function disableOne(it: DisableItem, opts: DisableOptions): DisableResult {
  const base = { type: it.type, name: it.name };
  try {
    if (invalid(it.name, it.source)) return { ...base, ok: false, message: "invalid artifact reference" };
    if (it.source.startsWith("plugin:")) return disablePlugin(it, opts);   // Task 3
    if (it.type === "skill") return disableSkill(it, opts);
    if (it.type === "mcp") return disableMcp(it, opts);                     // Task 4
    return { ...base, ok: false, message: `cannot disable ${it.type}` };
  } catch (e) {
    return { ...base, ok: false, message: (e as Error).message || "disable failed" };
  }
}
function enableOne(it: DisableItem, opts: DisableOptions): DisableResult {
  const base = { type: it.type, name: it.name };
  try {
    if (invalid(it.name, it.source)) return { ...base, ok: false, message: "invalid artifact reference" };
    if (it.type === "plugin" || it.source.startsWith("plugin:")) return enablePlugin(it, opts); // Task 3
    if (it.type === "skill") return enableSkill(it, opts);
    if (it.type === "mcp") return enableMcp(it, opts);                      // Task 4
    return { ...base, ok: false, message: `cannot enable ${it.type}` };
  } catch (e) {
    return { ...base, ok: false, message: (e as Error).message || "enable failed" };
  }
}

// ── skills: relocate the whole folder out of / back into the live skills root ──
function disableSkill(it: DisableItem, opts: DisableOptions): DisableResult {
  const base = { type: it.type, name: it.name };
  if (!SKILL_SOURCES.includes(it.source as SkillSource)) {
    return { ...base, ok: false, message: `source ${it.source} is not disable-eligible` };
  }
  const source = it.source as SkillSource;
  const from = join(resolveSkillRoot(source, opts), it.name);
  if (!existsSync(from)) return { ...base, ok: false, message: `skill folder not found: ${from}` };
  const to = join(archiveRoot(opts), "skills", source, it.name);
  if (existsSync(to)) return { ...base, ok: false, message: `already archived at ${to}` };
  mkdirSync(dirname(to), { recursive: true });
  renameSync(from, to);
  return { ...base, ok: true, message: `disabled (archived to ${to})` };
}
function enableSkill(it: DisableItem, opts: DisableOptions): DisableResult {
  const base = { type: it.type, name: it.name };
  if (!SKILL_SOURCES.includes(it.source as SkillSource)) {
    return { ...base, ok: false, message: `source ${it.source} is not disable-eligible` };
  }
  const source = it.source as SkillSource;
  const from = join(archiveRoot(opts), "skills", source, it.name);
  if (!existsSync(from)) return { ...base, ok: false, message: `not archived: ${from}` };
  const to = join(resolveSkillRoot(source, opts), it.name);
  if (existsSync(to)) return { ...base, ok: false, message: `already present: ${to}` };
  mkdirSync(dirname(to), { recursive: true });
  renameSync(from, to);
  return { ...base, ok: true, message: `re-enabled (restored to ${to})` };
}

// ── plugin branch: Task 3 replaces these stubs ──
function disablePlugin(it: DisableItem, _opts: DisableOptions): DisableResult {
  return { type: it.type, name: it.name, ok: false, message: "plugin disable not implemented" };
}
function enablePlugin(it: DisableItem, _opts: DisableOptions): DisableResult {
  return { type: it.type, name: it.name, ok: false, message: "plugin enable not implemented" };
}
// ── mcp branch: Task 4 replaces these stubs ──
function disableMcp(it: DisableItem, _opts: DisableOptions): DisableResult {
  return { type: it.type, name: it.name, ok: false, message: "mcp disable not implemented" };
}
function enableMcp(it: DisableItem, _opts: DisableOptions): DisableResult {
  return { type: it.type, name: it.name, ok: false, message: "mcp enable not implemented" };
}

// ── enumerate everything currently disabled (skill archive only in Task 2; Tasks 3–4 extend) ──
export function listDisabled(opts: DisableOptions = {}): DisabledArtifact[] {
  const out: DisabledArtifact[] = [];
  const skillsRoot = join(archiveRoot(opts), "skills");
  for (const source of SKILL_SOURCES) {
    const dir = join(skillsRoot, source);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) out.push({ type: "skill", name, source });
  }
  return out;
}
