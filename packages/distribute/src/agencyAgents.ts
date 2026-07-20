// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/agencyAgents.ts
//
// Inbound *adapter source* for github.com/msitarzewski/agency-agents. That repo is NOT an
// AgentGem registry (no registry.json; its items are single persona `.md` files, not Gem
// archives), so it can't be read as a gem registry. This module translates the
// repo's native division/`.md` layout into AgentGem skill artifacts on the fly.
//
// Casting decision (see docs): these files carry no `tools`/`model`/trigger machinery — only
// persona prose plus `color`/`emoji`/`vibe` decoration — so each maps to a SkillArtifact, not
// a first-class agent. `vibe` becomes the description fallback; `color`/`emoji`/`vibe` are
// surfaced on the catalog *entry* (for the picker UI) but kept OUT of the imported skill's
// content, so decoration never leaks into a Gem or its digest.
//
// All network goes through an injected `Http` (reused shape from registryTypes.ts) so the
// walk + transforms stay unit-testable with a fake. Reads use the token-optional Contents API,
// so public browsing needs no credentials (a token only lifts the 60/hr unauthenticated limit).
import type { SkillArtifact } from "@agentgem/model";
import type { Http, GithubCfg } from "./registryTypes.js";
import { ghContents, decodeFile, defaultHttp, splitFrontmatter, fmField } from "./githubContents.js";

export const AGENCY_AGENTS_REPO = { repo: "msitarzewski/agency-agents", ref: "main" } as const;

// Top-level dirs in the repo that are NOT agent divisions (tooling / docs / conversion output).
// Only used as a FALLBACK when divisions.json (the repo's own source of truth) can't be read;
// the primary path derives divisions from that file instead of this heuristic skip-list.
export const NON_AGENT_DIRS = new Set([
  "integrations", "scripts", "examples", "assets", "docs", ".github",
]);

// A division with its display metadata from the repo's divisions.json (its declared source of
// truth): a label, a Lucide icon name, and a brand color — ready to render a picker header.
export interface AgencyDivision {
  key: string;      // directory name, e.g. "engineering"
  label: string;    // display label, e.g. "Engineering"
  icon?: string;    // Lucide icon name, e.g. "Code"
  color?: string;   // brand hex, e.g. "#3B82F6"
}

export interface AgencyFrontmatter {
  name?: string;
  description?: string;
  vibe?: string;
  color?: string;
  emoji?: string;
}

// A browsable catalog entry: enough to render the picker (name/description/emoji/color/vibe)
// and to import on demand (division + path). Display attrs live here, not on the skill.
export interface AgencyAgentEntry {
  division: string;
  slug: string;                // filename without extension, e.g. "engineering-frontend-developer"
  name: string;                // skill name: slug with a leading "<division>-" stripped
  path: string;                // repo path, e.g. "engineering/engineering-frontend-developer.md"
  description?: string;
  vibe?: string;
  color?: string;
  emoji?: string;
}

export function agencyCfgFromEnv(): GithubCfg {
  return {
    repo: process.env.AGENCY_AGENTS_REPO ?? AGENCY_AGENTS_REPO.repo,
    ref: process.env.AGENCY_AGENTS_REF ?? AGENCY_AGENTS_REPO.ref,
    token: process.env.GITHUB_TOKEN,
  };
}

// ── pure transforms (the tested core; no network) ──────────────────────────────

export function parseAgentFrontmatter(md: string): { fm: AgencyFrontmatter; body: string } {
  const { fm, body } = splitFrontmatter(md);
  return {
    fm: {
      name: fmField(fm, "name"),
      description: fmField(fm, "description"),
      vibe: fmField(fm, "vibe"),
      color: fmField(fm, "color"),
      emoji: fmField(fm, "emoji"),
    },
    body,
  };
}

function divisionOf(path: string): string {
  return path.split("/")[0] ?? "";
}
function slugOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/i, "");
}
// Skill name = filename slug with a redundant leading "<division>-" removed
// (engineering/engineering-frontend-developer.md → "frontend-developer").
function skillNameOf(path: string): string {
  const slug = slugOf(path);
  const div = divisionOf(path);
  return div && slug.startsWith(`${div}-`) ? slug.slice(div.length + 1) : slug;
}

// Build a catalog entry (metadata + display) from a fetched agent file.
export function agentMdToEntry(path: string, md: string): AgencyAgentEntry {
  const { fm } = parseAgentFrontmatter(md);
  return {
    division: divisionOf(path),
    slug: slugOf(path),
    name: skillNameOf(path),
    path,
    description: fm.description ?? fm.vibe,
    vibe: fm.vibe,
    color: fm.color,
    emoji: fm.emoji,
  };
}

// Map an agent file → a clean AgentGem SkillArtifact. The emitted `content` is a NORMALIZED
// SKILL.md (canonical `name`/`description` frontmatter + the original body); the source's
// `color`/`emoji`/`vibe` are dropped from content so decoration never enters the Gem/digest.
// `description` falls back to `vibe` (its natural one-liner home), then to the name.
export function agentMdToSkill(path: string, md: string, sourceLabel = "agency-agents"): SkillArtifact {
  const { fm, body } = parseAgentFrontmatter(md);
  const name = skillNameOf(path);
  const description = fm.description ?? fm.vibe ?? name;
  const division = divisionOf(path);
  const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body.trimStart()}`;
  return {
    type: "skill",
    name,
    description,
    source: division ? `${sourceLabel}:${division}` : sourceLabel,
    content,
  };
}

// ── network helpers (thin; the transforms above carry the logic) ───────────────

interface DivisionsFile { divisions?: Record<string, { label?: string; icon?: string; color?: string }> }

// Title-case a division key as a fallback label ("game-development" → "Game Development").
function titleCase(key: string): string {
  return key.split(/[-_]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

// The authoritative division catalog from the repo's divisions.json (label + Lucide icon +
// brand color per division). Falls back to a root dir-walk minus NON_AGENT_DIRS — with
// synthesized labels and no icon/color — if divisions.json is missing or malformed.
export async function fetchAgencyDivisions(cfg: GithubCfg = agencyCfgFromEnv(), http: Http = defaultHttp): Promise<AgencyDivision[]> {
  try {
    const node = await ghContents(http, cfg, "divisions.json");
    if (Array.isArray(node)) throw new Error("divisions.json is a directory");
    const parsed = JSON.parse(decodeFile(node)) as DivisionsFile;
    const entries = Object.entries(parsed.divisions ?? {});
    if (entries.length === 0) throw new Error("divisions.json declares no divisions");
    return entries
      .map(([key, m]) => ({ key, label: m.label ?? titleCase(key), icon: m.icon, color: m.color }))
      .sort((a, b) => a.key.localeCompare(b.key));
  } catch {
    const root = await ghContents(http, cfg, "");
    if (!Array.isArray(root)) throw new Error("expected a directory listing at repo root");
    return root
      .filter((e) => e.type === "dir" && !NON_AGENT_DIRS.has(e.name))
      .map((e) => ({ key: e.name, label: titleCase(e.name) }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }
}

// Division directory names (keys only), sourced from the authoritative divisions.json.
export async function listAgencyDivisions(cfg: GithubCfg = agencyCfgFromEnv(), http: Http = defaultHttp): Promise<string[]> {
  return (await fetchAgencyDivisions(cfg, http)).map((d) => d.key);
}

// Agent `.md` files under a division (references only — no bodies fetched, so this is cheap).
export async function listAgencyAgents(
  division: string,
  cfg: GithubCfg = agencyCfgFromEnv(),
  http: Http = defaultHttp,
): Promise<{ division: string; slug: string; name: string; path: string }[]> {
  const node = await ghContents(http, cfg, division);
  if (!Array.isArray(node)) throw new Error(`expected a directory listing at ${division}`);
  return node
    .filter((e) => e.type === "file" && /\.md$/i.test(e.name) && !/^readme\.md$/i.test(e.name))
    .map((e) => ({ division, slug: slugOf(e.path), name: skillNameOf(e.path), path: e.path }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

// Fetch one agent file and return its browsable catalog entry (metadata + display).
export async function fetchAgencyAgentEntry(path: string, cfg: GithubCfg = agencyCfgFromEnv(), http: Http = defaultHttp): Promise<AgencyAgentEntry> {
  const node = await ghContents(http, cfg, path);
  if (Array.isArray(node)) throw new Error(`expected a file at ${path}, got a directory`);
  return agentMdToEntry(path, decodeFile(node));
}

// Fetch one agent file and import it as a SkillArtifact ready to bundle into a Gem.
export async function importAgencyAgentSkill(path: string, cfg: GithubCfg = agencyCfgFromEnv(), http: Http = defaultHttp): Promise<SkillArtifact> {
  const node = await ghContents(http, cfg, path);
  if (Array.isArray(node)) throw new Error(`expected a file at ${path}, got a directory`);
  return agentMdToSkill(path, decodeFile(node));
}
