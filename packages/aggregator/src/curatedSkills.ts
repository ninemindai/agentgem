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
      chunk.map((r) => sql`(${r.sourceId}, ${r.path}, ${r.division}, ${r.name}, ${r.repo}, ${r.source}, ${r.homepage}, ${r.stars}, ${r.installs})`),
      sql`, `,
    );
    await db.execute(sql`
      insert into curated_skills (source_id, path, division, name, repo, source_label, homepage, stars, installs)
      values ${values}
      on conflict (source_id, path) do update set
        division = excluded.division,
        name = excluded.name,
        repo = excluded.repo,
        source_label = excluded.source_label,
        homepage = excluded.homepage,
        stars = excluded.stars,
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
    repo: string; homepage: string | null; stars: number; installs: number | null;
  }>(sql`
    select source_id as "sourceId", source_label as "source", division, name, path, repo, homepage, stars, installs
    from curated_skills
    order by coalesce(installs, 0) desc, stars desc, name asc
    limit ${limit}
  `);
  return r.rows as CuratedSkillRow[];
}
