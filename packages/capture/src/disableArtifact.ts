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

// ── plugins: reversible via settings.json enabledPlugins flag ──
function disablePlugin(it: DisableItem, opts: DisableOptions): DisableResult {
  const base = { type: it.type, name: it.name };
  const key = it.source.slice("plugin:".length);
  const p = settingsPath(opts);
  const settings = readJson(p);
  const obj = settings && typeof settings === "object" ? settings : {};
  obj.enabledPlugins = { ...(obj.enabledPlugins ?? {}), [key]: false };
  writeJson(p, obj);
  return { ...base, ok: true, message: `plugin ${key} disabled` };
}
function enablePlugin(it: DisableItem, opts: DisableOptions): DisableResult {
  const base = { type: it.type, name: it.name };
  // name carries the plugin key for a "plugin"-typed row; source carries it otherwise.
  const key = it.source.startsWith("plugin:") ? it.source.slice("plugin:".length) : it.name;
  const p = settingsPath(opts);
  const settings = readJson(p);
  const obj = settings && typeof settings === "object" ? settings : {};
  obj.enabledPlugins = { ...(obj.enabledPlugins ?? {}), [key]: true };
  writeJson(p, obj);
  return { ...base, ok: true, message: `plugin ${key} re-enabled` };
}
// ── mcp: settings.json entries are stashed (reversible); .mcp.json servers use a flag ──
function mcpJsonServers(opts: DisableOptions): Record<string, unknown> {
  const parsed = readJson(join(claudeConfigDir(opts), ".mcp.json"));
  if (!parsed || typeof parsed !== "object") return {};
  const servers = (parsed as any).mcpServers;
  if (servers && typeof servers === "object") return servers;
  return parsed as Record<string, unknown>;
}
function disableMcp(it: DisableItem, opts: DisableOptions): DisableResult {
  const base = { type: it.type, name: it.name };
  const p = settingsPath(opts);
  const settings = readJson(p);
  const obj = settings && typeof settings === "object" ? settings : {};
  const servers = obj.mcpServers && typeof obj.mcpServers === "object" ? obj.mcpServers : undefined;
  if (servers && it.name in servers) {
    const stash = join(archiveRoot(opts), "mcp", `${it.name}.json`);
    if (existsSync(stash)) return { ...base, ok: false, message: `already stashed at ${stash}` };
    writeJson(stash, { name: it.name, config: servers[it.name] });
    delete servers[it.name];
    obj.mcpServers = servers;
    writeJson(p, obj);
    return { ...base, ok: true, message: `mcp ${it.name} disabled (stashed)` };
  }
  if (it.name in mcpJsonServers(opts)) {
    const list: string[] = Array.isArray(obj.disabledMcpjsonServers) ? obj.disabledMcpjsonServers : [];
    if (!list.includes(it.name)) list.push(it.name);
    obj.disabledMcpjsonServers = list;
    writeJson(p, obj);
    return { ...base, ok: true, message: `mcp ${it.name} disabled (flagged)` };
  }
  return { ...base, ok: false, message: `mcp ${it.name} not found in settings.json or .mcp.json` };
}
function enableMcp(it: DisableItem, opts: DisableOptions): DisableResult {
  const base = { type: it.type, name: it.name };
  const p = settingsPath(opts);
  const settings = readJson(p);
  const obj = settings && typeof settings === "object" ? settings : {};
  const stash = join(archiveRoot(opts), "mcp", `${it.name}.json`);
  if (existsSync(stash)) {
    const saved = readJson(stash);
    const servers = obj.mcpServers && typeof obj.mcpServers === "object" ? obj.mcpServers : {};
    if (it.name in servers) return { ...base, ok: false, message: `already present in mcpServers` };
    servers[it.name] = saved?.config ?? {};
    obj.mcpServers = servers;
    writeJson(p, obj);
    rmSync(stash, { force: true });
    return { ...base, ok: true, message: `mcp ${it.name} restored` };
  }
  const list: string[] = Array.isArray(obj.disabledMcpjsonServers) ? obj.disabledMcpjsonServers : [];
  if (list.includes(it.name)) {
    obj.disabledMcpjsonServers = list.filter((n) => n !== it.name);
    writeJson(p, obj);
    return { ...base, ok: true, message: `mcp ${it.name} re-enabled` };
  }
  return { ...base, ok: false, message: `mcp ${it.name} is not disabled` };
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
  const settings = readJson(settingsPath(opts));
  const enabled = settings && typeof settings === "object" && settings.enabledPlugins && typeof settings.enabledPlugins === "object"
    ? settings.enabledPlugins as Record<string, unknown> : {};
  for (const [key, v] of Object.entries(enabled)) {
    if (v === false) out.push({ type: "plugin", name: key, source: `plugin:${key}` });
  }
  const disabledMcpjson = settings && typeof settings === "object" && Array.isArray(settings.disabledMcpjsonServers)
    ? settings.disabledMcpjsonServers as string[] : [];
  for (const name of disabledMcpjson) out.push({ type: "mcp", name, source: "user" });
  const mcpStash = join(archiveRoot(opts), "mcp");
  if (existsSync(mcpStash)) {
    for (const f of readdirSync(mcpStash)) {
      if (f.endsWith(".json")) out.push({ type: "mcp", name: f.replace(/\.json$/, ""), source: "user" });
    }
  }
  return out;
}
