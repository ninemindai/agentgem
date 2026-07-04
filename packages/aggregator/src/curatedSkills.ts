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

// Ranked for the "Popular Skills" board: highest `installs` first (once the enrichment lands),
// then stars, then name for a stable tie-break.
export async function popularSkills(db: AppDb, opts: { limit?: number } = {}): Promise<CuratedSkillRow[]> {
  const limit = opts.limit ?? 50;
  const r = await db.execute<{
    sourceId: string; source: string; division: string; name: string; path: string;
    repo: string; homepage: string | null; stars: number; installs: number | null; description: string | null;
  }>(sql`
    select source_id as "sourceId", source_label as "source", division, name, path, repo, homepage, stars, installs, description
    from curated_skills
    order by coalesce(installs, 0) desc, stars desc, name asc
    limit ${limit}
  `);
  return r.rows as CuratedSkillRow[];
}

// Grouped for the "Popular Skills" board: one group per source (ordered by the source repo's
// GitHub stars — stars belong to the repo, not the skill), each with its skills ranked
// installs-desc-then-name (same tie-break as popularSkills, minus the stars term since every
// skill in a group shares the same repo/stars).
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
