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
import type { Http, GithubCfg } from "./registryTypes.js";
import { ghTree, ghContents, decodeFile, defaultHttp, splitFrontmatter, fmField } from "./githubContents.js";
import type { AgencyDivision, AgencyAgentEntry } from "./agencyAgents.js";

// Path segments that mark a `SKILL.md` as out of scope for the picker — repo tooling, docs,
// deprecated or example content, not a real skill.
const IGNORE = new Set([
  ".github", "node_modules", "deprecated", ".out-of-scope", "examples", "templates", "test", "tests",
]);

// Dot-prefixed dirs are excluded as repo tooling (.github, .vscode) — EXCEPT the two standard
// on-disk skill roots. `~/.agents/skills/<name>` is where this project's own installer writes,
// and `.claude/skills/` is the Claude Code convention; a repo that follows either would
// otherwise have every one of its skills filtered out as if it had none.
const SKILL_ROOTS = new Set([".agents", ".claude"]);

function isIgnored(path: string): boolean {
  return path.split("/").some((seg, i) => {
    if (seg.startsWith(".")) return !(i === 0 && SKILL_ROOTS.has(seg));
    return IGNORE.has(seg);
  });
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
// Leading "." permitted only for the standard skill roots above (".agents/", ".claude/"); the
// explicit ".." check below still blocks traversal.
export const SKILLS_PATH_RE = /^(?:\.(?:agents|claude)\/)?[A-Za-z0-9][A-Za-z0-9._/-]*\/SKILL\.md$/;
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

// Bundle bounds. A skill's siblings are docs and small scripts; anything past these is not a
// skill bundle, and fetching it would mean one GitHub request per file against a rate limit we
// share with browsing. When a bound bites we SAY so (filesTruncated) rather than quietly
// shipping a partial bundle.
export const MAX_BUNDLE_FILES = 20;
export const MAX_BUNDLE_BYTES = 256_000;

// Text extensions we carry. A skill's references are markdown; its scripts are small source
// files. Binaries (images, archives) are skipped — decodeFile would mangle them into utf8, and
// a broken asset is worse than an absent one. Skipping sets filesTruncated.
const BUNDLE_EXT = new Set(["md", "txt", "json", "yaml", "yml", "mjs", "js", "ts", "sh", "py", "toml", "csv"]);

// A bundle path must stay inside the skill directory once written. The GitHub tree is not a
// trusted input for a filesystem write: reject traversal, absolute paths, and empty segments.
export function safeBundlePath(rel: string): boolean {
  if (!rel || rel.startsWith("/") || rel.includes("\\")) return false;
  const segs = rel.split("/");
  return segs.every((s) => s.length > 0 && s !== "." && s !== "..");
}

// Every sibling file under a skill's directory, fetched and returned with skill-dir-relative
// paths. Never throws: the bundle is an enhancement over the SKILL.md, so a failed listing
// degrades to "no files, marked incomplete" rather than failing the whole import.
async function fetchSkillBundle(
  skillPath: string,
  cfg: GithubCfg,
  http: Http,
): Promise<{ files: { path: string; content: string }[]; truncated: boolean }> {
  const dir = skillPath.slice(0, -"SKILL.md".length);   // keeps the trailing "/"
  let tree: { path: string; type: string }[];
  try {
    tree = await ghTree(http, cfg);
  } catch {
    return { files: [], truncated: true };   // couldn't confirm completeness — say so
  }

  const siblings = tree
    .filter((e) => e.type === "blob" && e.path.startsWith(dir) && e.path !== skillPath)
    .map((e) => e.path)
    .sort();

  let truncated = false;
  const wanted: string[] = [];
  for (const p of siblings) {
    const rel = p.slice(dir.length);
    const ext = rel.split(".").pop()?.toLowerCase() ?? "";
    if (!BUNDLE_EXT.has(ext) || !safeBundlePath(rel)) { truncated = true; continue; }
    if (wanted.length >= MAX_BUNDLE_FILES) { truncated = true; continue; }
    wanted.push(p);
  }

  const files: { path: string; content: string }[] = [];
  let bytes = 0;
  for (const p of wanted) {
    try {
      const node = await ghContents(http, cfg, p);
      if (Array.isArray(node)) { truncated = true; continue; }
      const content = decodeFile(node);
      if (bytes + content.length > MAX_BUNDLE_BYTES) { truncated = true; continue; }
      bytes += content.length;
      files.push({ path: p.slice(dir.length), content });
    } catch {
      truncated = true;   // one unreadable sibling must not sink the import
    }
  }
  return { files, truncated };
}

// Fetch one SKILL.md and import it verbatim as a SkillArtifact. It is already a canonical
// SKILL.md (unlike agency-agents' persona `.md`), so content is NOT re-wrapped/normalized.
// Sibling files under the skill directory ride along in `files` — without them a
// progressive-disclosure skill's "read references/x.md" instructions point at nothing.
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
  const bundle = await fetchSkillBundle(path, cfg, http);
  return {
    type: "skill",
    name,
    description,
    source: `${sourceLabel}:${divisionOf(path)}`,
    content,
    ...(bundle.files.length ? { files: bundle.files } : {}),
    ...(bundle.truncated ? { filesTruncated: true } : {}),
  };
}
