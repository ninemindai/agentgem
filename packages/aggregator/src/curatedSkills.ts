// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/curatedSkills.ts
//
// Query module for the curated_skills index (see schema.ts) that backs the marketplace
// "Popular Skills" board. Rows are written by the app-layer indexer (curatedSkillsIndexer.ts,
// bridging @agentgem/distribute's CURATED_SOURCES into this DB) and read here for the public
// GET /api/aggregator/popular-skills endpoint.
import { sql } from "drizzle-orm";
import type { AppDb } from "./schema.js";

export interface CuratedSkillRow {
  sourceId: string;
  source: string; // the curated source's display label (schema column: source_label)
  division: string;
  name: string;
  path: string;
  repo: string;
  homepage: string | null;
  stars: number;
  installs: number | null;
  description: string | null;
}

// One source group ("Popular Skills" board, grouped-by-source view): the source's repo metadata
// once, then its skills (capped to `perSource`), already ranked installs-then-name.
export interface CuratedSkillGroup {
  sourceId: string;
  source: string;
  repo: string;
  homepage: string | null;
  stars: number;
  skills: { name: string; path: string; division: string; description: string | null; installs: number | null }[];
}

// Postgres caps bound params per statement well above this, but chunking keeps each statement
// small and bounded regardless of how many curated sources/skills accumulate over time.
const UPSERT_CHUNK = 500;

// Bulk upsert keyed on (source_id, path). Never overwrites `installs` — that column is owned by
// a later skills.sh enrichment pass, and re-indexing (refreshed stars/skill list) must not
// clobber it. Returns the number of rows upserted.
export async function upsertCuratedSkills(db: AppDb, rows: CuratedSkillRow[]): Promise<number> {
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK);
    if (chunk.length === 0) continue;
    const values = sql.join(
      chunk.map((r) => sql`(${r.sourceId}, ${r.path}, ${r.division}, ${r.name}, ${r.repo}, ${r.source}, ${r.homepage}, ${r.stars}, ${r.installs}, ${r.description})`),
      sql`, `,
    );
    await db.execute(sql`
      insert into curated_skills (source_id, path, division, name, repo, source_label, homepage, stars, installs, description)
      values ${values}
      on conflict (source_id, path) do update set
        division = excluded.division,
        name = excluded.name,
        repo = excluded.repo,
        source_label = excluded.source_label,
        homepage = excluded.homepage,
        stars = excluded.stars,
        description = excluded.description,
        indexed_at = now()
    `);
  }
  return rows.length;
}

// Real display names for review targets. A review's target id is "<sourceId>/<path>", which equals
// `source_id || '/' || path` here — so we reconstruct that key to look up the curated `name` (the
// frontmatter name, e.g. "ask-matt", not the file basename "SKILL"). Returns targetId → name for
// the rows that exist; callers fall back for skills not in the curated index.
// IMPORTANT: Only returns public (org_scope IS NULL) rows — private org-scoped skills are never exposed here.
export async function skillNamesByTargetId(db: AppDb, targetIds: string[]): Promise<Record<string, string>> {
  if (targetIds.length === 0) return {};
  const list = sql.join(targetIds.map((t) => sql`${t}`), sql`, `);
  const r = await db.execute<{ tid: string; name: string }>(sql`
    select (source_id || '/' || path) as "tid", name
    from curated_skills
    where org_scope is null and (source_id || '/' || path) in (${list})
  `);
  const out: Record<string, string> = {};
  for (const row of r.rows) out[row.tid] = row.name;
  return out;
}

// Ranked for the "Popular Skills" board: highest `installs` first (once the enrichment lands),
// then stars, then name for a stable tie-break. Only includes public (org_scope IS NULL) rows.
export async function popularSkills(db: AppDb, opts: { limit?: number } = {}): Promise<CuratedSkillRow[]> {
  const limit = opts.limit ?? 50;
  const r = await db.execute<{
    sourceId: string; source: string; division: string; name: string; path: string;
    repo: string; homepage: string | null; stars: number; installs: number | null; description: string | null;
  }>(sql`
    select source_id as "sourceId", source_label as "source", division, name, path, repo, homepage, stars, installs, description
    from curated_skills
    where org_scope is null
    order by coalesce(installs, 0) desc, stars desc, name asc
    limit ${limit}
  `);
  return r.rows as CuratedSkillRow[];
}

// Grouped for the "Popular Skills" board: one group per source (ordered by the source repo's
// GitHub stars — stars belong to the repo, not the skill), each with its skills ranked
// installs-desc-then-name (same tie-break as popularSkills, minus the stars term since every
// skill in a group shares the same repo/stars). Only includes public (org_scope IS NULL) rows.
export async function popularSkillGroups(
  db: AppDb,
  opts: { sources?: number; perSource?: number } = {},
): Promise<CuratedSkillGroup[]> {
  const maxSources = opts.sources ?? 12;
  const perSource = opts.perSource ?? 6;
  const r = await db.execute<{
    sourceId: string; source: string; repo: string; homepage: string | null; stars: number;
    division: string; name: string; path: string; description: string | null; installs: number | null;
  }>(sql`
    select source_id as "sourceId", source_label as "source", repo, homepage, stars, division, name, path, description, installs
    from curated_skills
    where org_scope is null
    order by stars desc, source_id, coalesce(installs, 0) desc, name asc
  `);

  const groups: CuratedSkillGroup[] = [];
  const bySourceIndex = new Map<string, number>();
  for (const row of r.rows) {
    let idx = bySourceIndex.get(row.sourceId);
    if (idx === undefined) {
      if (groups.length >= maxSources) continue; // already capped; skip remaining sources' rows
      idx = groups.length;
      bySourceIndex.set(row.sourceId, idx);
      groups.push({ sourceId: row.sourceId, source: row.source, repo: row.repo, homepage: row.homepage, stars: row.stars, skills: [] });
    }
    const group = groups[idx]!;
    if (group.skills.length < perSource) {
      group.skills.push({ name: row.name, path: row.path, division: row.division, description: row.description, installs: row.installs });
    }
  }
  return groups;
}

// ── org-scoped (private) skills — GitHub App sources ────────────────────────────────────────
// Same table, org_scope NOT NULL, source_id "org:<owner>/<repo>". Public reads above filter
// org_scope IS NULL; these rows are served only through the member-gated /api/orgs endpoints.

export interface OrgSkillRow { sourceId: string; path: string; division: string; name: string; repo: string; description: string | null }

/** Replace the indexed skill set for one (org, repo): delete-then-insert so upstream deletions
 *  disappear. Metadata only — bodies are never stored. Returns the new row count. */
export async function replaceOrgRepoSkills(db: AppDb, orgScope: string, repo: string, rows: OrgSkillRow[]): Promise<number> {
  const scope = orgScope.toLowerCase();
  // One transaction so the delete + re-insert are atomic. Without it, a concurrent request between
  // the delete and the first insert sees zero rows — orgSkillExists (the body-proxy access gate)
  // falsely denies a legitimate private skill — and an insert failure leaves the org's skills deleted.
  await db.transaction(async (tx) => {
    await tx.execute(sql`delete from curated_skills where org_scope = ${scope} and repo = ${repo}`);
    for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
      const chunk = rows.slice(i, i + UPSERT_CHUNK);
      if (chunk.length === 0) continue;
      const values = sql.join(
        chunk.map((r) => sql`(${r.sourceId}, ${r.path}, ${r.division}, ${r.name}, ${r.repo}, ${r.repo}, ${null}, ${0}, ${null}, ${r.description}, ${scope})`),
        sql`, `,
      );
      await tx.execute(sql`
        insert into curated_skills (source_id, path, division, name, repo, source_label, homepage, stars, installs, description, org_scope)
        values ${values}
        on conflict (source_id, path) do update set
          division = excluded.division, name = excluded.name, repo = excluded.repo,
          source_label = excluded.source_label, description = excluded.description,
          org_scope = excluded.org_scope, indexed_at = now()
      `);
    }
  });
  return rows.length;
}

export async function deleteOrgRepoSkills(db: AppDb, orgScope: string, repo: string): Promise<void> {
  await db.execute(sql`delete from curated_skills where org_scope = ${orgScope.toLowerCase()} and repo = ${repo}`);
}

export async function deleteOrgSkills(db: AppDb, orgScope: string): Promise<void> {
  await db.execute(sql`delete from curated_skills where org_scope = ${orgScope.toLowerCase()}`);
}

export async function listOrgSkills(db: AppDb, orgScope: string): Promise<OrgSkillRow[]> {
  const r = await db.execute<{ sourceId: string; path: string; division: string; name: string; repo: string; description: string | null }>(sql`
    select source_id as "sourceId", path, division, name, repo, description
    from curated_skills where org_scope = ${orgScope.toLowerCase()}
    order by repo, division, name
  `);
  return r.rows as OrgSkillRow[];
}

/** True iff (sourceId, path) is an indexed private skill of THIS org — the body-proxy boundary. */
export async function orgSkillExists(db: AppDb, orgScope: string, sourceId: string, path: string): Promise<boolean> {
  const r = await db.execute<{ one: number }>(sql`
    select 1 as one from curated_skills
    where org_scope = ${orgScope.toLowerCase()} and source_id = ${sourceId} and path = ${path} limit 1
  `);
  return r.rows.length > 0;
}

/** Reconcile-time ghost-skill prune: delete this org's rows for repos NOT in keepRepos. Repos
 *  deleted/renamed/transferred upstream — or deselected while the installation was suspended —
 *  never produce a removal webhook this server processes; the authoritative current repo list
 *  closes that gap. Empty keepRepos = the installation sees no repos → forget all the org's rows.
 *  Callers must NOT invoke this from a truncated repo listing. */
export async function pruneOrgSkills(db: AppDb, orgScope: string, keepRepos: string[]): Promise<void> {
  const scope = orgScope.toLowerCase();
  if (keepRepos.length === 0) {
    await db.execute(sql`delete from curated_skills where org_scope = ${scope}`);
    return;
  }
  const keep = sql.join(keepRepos.map((r) => sql`${r}`), sql`, `);
  await db.execute(sql`delete from curated_skills where org_scope = ${scope} and repo not in (${keep})`);
}
