// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/skillsLayout.ts
//
// Inbound *adapter source* for the many github repos that use the generic `SKILL.md` convention
// (one skill per `<division>/<name>/SKILL.md`, e.g. mattpocock/skills + ~40 others in
// curatedSources.ts). Unlike agency-agents these are already canonical AgentGem-shaped skills
// (name/description frontmatter + an instructions body), so import returns the file verbatim —
// no re-wrapping/normalization. This module mirrors the *shapes* agencyAgents.ts returns
// (AgencyDivision, the {division,slug,name,path} ref, AgencyAgentEntry) so dispatch-by-kind
// (sourceImport.ts) can treat both adapters uniformly.
//
// All network goes through an injected `Http` so the walk stays unit-testable with a fake. Reads
// use the token-optional Contents/Trees API, so public browsing needs no credentials.
import type { SkillArtifact } from "@agentgem/model";
import { InvalidInputError } from "@agentgem/model";
import type { Http, GithubCfg } from "./registryGithub.js";
import { ghTree, ghContents, decodeFile, defaultHttp, splitFrontmatter, fmField } from "./githubContents.js";
import type { AgencyDivision, AgencyAgentEntry } from "./agencyAgents.js";

// Path segments that mark a `SKILL.md` as out of scope for the picker — repo tooling, docs,
// deprecated or example content, not a real skill.
const IGNORE = new Set([
  ".github", "node_modules", "deprecated", ".out-of-scope", "examples", "templates", "test", "tests",
]);

function isIgnored(path: string): boolean {
  return path.split("/").some((seg) => seg.startsWith(".") || IGNORE.has(seg));
}

// name/division from a `.../<div>/<name>/SKILL.md` path (`<name>/SKILL.md` at repo root →
// division "root"). e.g. "skills/engineering/ask-matt/SKILL.md" → name "ask-matt", division
// "engineering"; "skills/foo/SKILL.md" → name "foo", division "skills"; "foo/SKILL.md" → name
// "foo", division "root".
function dirPartsOf(path: string): string[] {
  return path.slice(0, -"/SKILL.md".length).split("/");
}
function nameOf(path: string): string {
  const parts = dirPartsOf(path);
  return parts.at(-1) ?? path;
}
function divisionOf(path: string): string {
  const parts = dirPartsOf(path);
  return parts.at(-2) ?? "root";
}

// A {division,name,path} ref for a bare SKILL.md path with no extra network call — used by
// sourceImport.ts's listSourceSkills to derive every skill's ref from one listSkillMd() tree
// listing, instead of listSkillsAgents' per-division re-fetch.
export function skillRefFromPath(path: string): { division: string; name: string; path: string } {
  return { division: divisionOf(path), name: nameOf(path), path };
}

// Title-case a division key as a fallback label ("game-development" → "Game Development").
function titleCase(key: string): string {
  return key.split(/[-_]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

// Input containment: a path must be a `SKILL.md` under at least one directory segment, with no
// traversal — bounds what we fetch to files that could plausibly be a real skill in the repo.
export const SKILLS_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*\/SKILL\.md$/;
export function assertSkillsPath(path: string): string {
  if (path.includes("..") || !SKILLS_PATH_RE.test(path)) throw new InvalidInputError(`Invalid skill path '${path}'.`);
  return path;
}

// Every `SKILL.md` blob path in the repo, minus ignored ones, sorted.
export async function listSkillMd(cfg: GithubCfg, http: Http = defaultHttp): Promise<string[]> {
  const tree = await ghTree(http, cfg);
  return tree
    .filter((e) => e.type === "blob" && e.path.endsWith("/SKILL.md") && !isIgnored(e.path))
    .map((e) => e.path)
    .sort();
}

// Divisions are just the unique parent-of-parent directory across all skills — this layout has
// no divisions.json, so labels are synthesized (no icon/color).
export async function fetchSkillsDivisions(cfg: GithubCfg, http: Http = defaultHttp): Promise<AgencyDivision[]> {
  const paths = await listSkillMd(cfg, http);
  const keys = [...new Set(paths.map(divisionOf))].sort();
  return keys.map((key) => ({ key, label: titleCase(key) }));
}

// Skill file references under a division (no bodies fetched — cheap listing).
export async function listSkillsAgents(
  division: string,
  cfg: GithubCfg,
  http: Http = defaultHttp,
): Promise<{ division: string; slug: string; name: string; path: string }[]> {
  const paths = await listSkillMd(cfg, http);
  return paths
    .filter((p) => divisionOf(p) === division)
    .map((p) => {
      const name = nameOf(p);
      return { division, slug: name, name, path: p };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Fetch one SKILL.md and return its browsable catalog entry (metadata + display).
export async function fetchSkillsEntry(path: string, cfg: GithubCfg, http: Http = defaultHttp): Promise<AgencyAgentEntry> {
  const node = await ghContents(http, cfg, path);
  if (Array.isArray(node)) throw new Error(`expected a file at ${path}, got a directory`);
  const { fm } = splitFrontmatter(decodeFile(node));
  const dirName = nameOf(path);
  return {
    division: divisionOf(path),
    slug: dirName,
    name: fmField(fm, "name") ?? dirName,
    path,
    description: fmField(fm, "description"),
  };
}

// Fetch one SKILL.md and import it verbatim as a SkillArtifact. It is already a canonical
// SKILL.md (unlike agency-agents' persona `.md`), so content is NOT re-wrapped/normalized.
export async function importSkillsSkill(
  path: string,
  cfg: GithubCfg,
  http: Http = defaultHttp,
  sourceLabel: string = cfg.repo,
): Promise<SkillArtifact> {
  const node = await ghContents(http, cfg, path);
  if (Array.isArray(node)) throw new Error(`expected a file at ${path}, got a directory`);
  const content = decodeFile(node);
  const { fm } = splitFrontmatter(content);
  const dirName = nameOf(path);
  const name = fmField(fm, "name") ?? dirName;
  const description = fmField(fm, "description") ?? name;
  return {
    type: "skill",
    name,
    description,
    source: `${sourceLabel}:${divisionOf(path)}`,
    content,
  };
}
