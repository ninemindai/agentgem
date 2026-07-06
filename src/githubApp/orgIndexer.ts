// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/githubApp/orgIndexer.ts
// Walks one installation repo for SKILL.md files (the same skills-layout machinery the public
// curated sources use, authenticated with an installation token) and replaces that (org, repo)
// slice of curated_skills. METADATA ONLY — bodies are never stored (the data-custody boundary);
// reads go through the member-gated /api/orgs/skill-body proxy instead.
import { replaceOrgRepoSkills, type AppDb, type OrgSkillRow } from "@agentgem/aggregator";
import { listSkillMd, fetchSkillsEntry, skillRefFromPath, type Http, type GithubCfg } from "@agentgem/distribute";

export async function indexOrgRepo(db: AppDb, http: Http, token: string, orgScope: string, repo: string, ref: string): Promise<number> {
  const cfg: GithubCfg = { repo, ref, token };
  const paths = await listSkillMd(cfg, http);
  const rows: OrgSkillRow[] = [];
  for (const path of paths) {
    const r = skillRefFromPath(path);
    // One entry fetch per skill for the frontmatter name/description; a single skill failing
    // (404 mid-push, malformed frontmatter) must not sink the repo — index it path-derived.
    let name = r.name;
    let description: string | null = null;
    try {
      const entry = await fetchSkillsEntry(path, cfg, http);
      name = entry.name ?? r.name;
      description = entry.description ?? null;
    } catch { /* keep path-derived name, null description */ }
    rows.push({ sourceId: `org:${repo}`, path, division: r.division, name, repo, description });
  }
  await replaceOrgRepoSkills(db, orgScope, repo, rows);
  return rows.length;
}
