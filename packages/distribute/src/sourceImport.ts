// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/sourceImport.ts
//
// Dispatch-by-kind over the curated-source adapters (agencyAgents, skillsLayout) so the
// controller/core layers (sources.controller.ts, sourcesCore.ts) treat every `CuratedSource`
// uniformly regardless of its on-disk layout. Adding a third `kind` means adding one branch per
// function here, not touching every call site.
import type { SkillArtifact } from "@agentgem/model";
import { InvalidInputError } from "@agentgem/model";
import type { Http, GithubCfg } from "./registryTypes.js";
import { defaultHttp } from "./githubContents.js";
import type { CuratedSource } from "./curatedSources.js";
import {
  fetchAgencyDivisions,
  listAgencyAgents,
  fetchAgencyAgentEntry,
  importAgencyAgentSkill,
  type AgencyDivision,
  type AgencyAgentEntry,
} from "./agencyAgents.js";
import {
  fetchSkillsDivisions,
  listSkillsAgents,
  fetchSkillsEntry,
  importSkillsSkill,
  assertSkillsPath,
  listSkillMd,
  skillRefFromPath,
} from "./skillsLayout.js";

// Input containment: an agency-layout path is exactly "<division>/<file>.md" — bounds what we
// fetch to the source repo's persona layout (a caller can't walk to arbitrary repo files or
// traverse out; the repo itself is fixed per source). Moved here (from sources.controller.ts) so
// both the controller and sourcesCore validate through the one `assertSourcePath` entry point.
const AGENCY_PATH_RE = /^[a-z0-9-]+\/[A-Za-z0-9._-]+\.md$/;

export function assertSourcePath(source: CuratedSource, path: string): string {
  if (source.kind === "agency-layout") {
    if (path.includes("..") || !AGENCY_PATH_RE.test(path)) throw new InvalidInputError(`Invalid agent path '${path}'.`);
    return path;
  }
  return assertSkillsPath(path);
}

export function sourceDivisions(source: CuratedSource, cfg: GithubCfg, http: Http = defaultHttp): Promise<AgencyDivision[]> {
  return source.kind === "agency-layout" ? fetchAgencyDivisions(cfg, http) : fetchSkillsDivisions(cfg, http);
}

export function sourceAgents(
  source: CuratedSource,
  division: string,
  cfg: GithubCfg,
  http: Http = defaultHttp,
): Promise<{ division: string; slug: string; name: string; path: string }[]> {
  return source.kind === "agency-layout" ? listAgencyAgents(division, cfg, http) : listSkillsAgents(division, cfg, http);
}

export function sourceEntry(source: CuratedSource, path: string, cfg: GithubCfg, http: Http = defaultHttp): Promise<AgencyAgentEntry> {
  return source.kind === "agency-layout" ? fetchAgencyAgentEntry(path, cfg, http) : fetchSkillsEntry(path, cfg, http);
}

export function importSourceSkill(source: CuratedSource, path: string, cfg: GithubCfg, http: Http = defaultHttp): Promise<SkillArtifact> {
  return source.kind === "agency-layout"
    ? importAgencyAgentSkill(path, cfg, http)
    : importSkillsSkill(path, cfg, http, source.id);
}

// Every skill ref in a source, in one efficient pass — used by the "Popular Skills" indexer
// (curatedSkillsIndexer.ts), which needs the full list rather than one division at a time.
// skills-layout: a single listSkillMd() tree listing. agency-layout: one fetchAgencyDivisions()
// call plus one listAgencyAgents() per division, flattened.
export async function listSourceSkills(
  source: CuratedSource,
  cfg: GithubCfg,
  http: Http = defaultHttp,
): Promise<{ division: string; name: string; path: string }[]> {
  if (source.kind === "skills-layout") {
    const paths = await listSkillMd(cfg, http);
    return paths.map(skillRefFromPath);
  }
  const divisions = await fetchAgencyDivisions(cfg, http);
  const perDivision = await Promise.all(divisions.map((d) => listAgencyAgents(d.key, cfg, http)));
  return perDivision.flat().map(({ division, name, path }) => ({ division, name, path }));
}
