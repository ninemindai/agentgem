// src/__tests__/curatedSkills.test.ts
//
// @agentgem/aggregator's curated_skills query module: bulk upsert (keyed on source_id+path,
// never overwriting `installs`) and popularSkills' ranking (installs desc, then stars desc, then
// name asc).
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, upsertCuratedSkills, popularSkills, type CuratedSkillRow } from "@agentgem/aggregator";

function row(over: Partial<CuratedSkillRow>): CuratedSkillRow {
  return {
    sourceId: "src", source: "Src Label", division: "root", name: "a", path: "a/SKILL.md",
    repo: "owner/src", homepage: null, stars: 0, installs: null, ...over,
  };
}

describe("upsertCuratedSkills + popularSkills", () => {
  it("ranks by installs desc, then stars desc, then name asc", async () => {
    const db = await makeTestDb();
    await upsertCuratedSkills(db, [
      row({ path: "a/SKILL.md", name: "a", stars: 5, installs: null }),
      row({ path: "b/SKILL.md", name: "b", stars: 50, installs: null }),
      row({ path: "c/SKILL.md", name: "c", stars: 1, installs: 10 }),
      row({ path: "d/SKILL.md", name: "d", stars: 5, installs: null }), // ties "a" on stars -> name asc
    ]);
    const rows = await popularSkills(db, { limit: 10 });
    expect(rows.map((r) => r.name)).toEqual(["c", "b", "a", "d"]);
  });

  it("upserts on (sourceId, path): re-indexing updates stars/name/division but never installs", async () => {
    const db = await makeTestDb();
    await upsertCuratedSkills(db, [row({ path: "x/SKILL.md", name: "x", stars: 1, installs: null })]);
    // Simulate a later skills.sh enrichment setting installs directly (out of band from the
    // indexer, which never writes this column) — raw SQL, not upsertCuratedSkills, since that
    // function intentionally cannot set installs.
    await db.execute(sql`update curated_skills set installs = 42 where source_id = 'src' and path = 'x/SKILL.md'`);
    let rows = await popularSkills(db, { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stars: 1, installs: 42 });

    // Re-index with new stars/name/division for the same key: installs must survive untouched.
    await upsertCuratedSkills(db, [row({ path: "x/SKILL.md", name: "renamed", division: "eng", stars: 99, installs: null })]);
    rows = await popularSkills(db, { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "renamed", division: "eng", stars: 99, installs: 42 });
  });

  it("returns the exact response shape (sourceId/source/division/name/path/repo/homepage/stars/installs)", async () => {
    const db = await makeTestDb();
    await upsertCuratedSkills(db, [row({ path: "y/SKILL.md", name: "y", source: "The Source", repo: "owner/repo", homepage: "https://example.com", stars: 7 })]);
    const rows = await popularSkills(db, { limit: 10 });
    expect(rows[0]).toEqual({
      sourceId: "src", source: "The Source", division: "root", name: "y", path: "y/SKILL.md",
      repo: "owner/repo", homepage: "https://example.com", stars: 7, installs: null,
    });
  });

  it("respects the limit", async () => {
    const db = await makeTestDb();
    await upsertCuratedSkills(db, [
      row({ path: "a/SKILL.md", name: "a" }),
      row({ path: "b/SKILL.md", name: "b" }),
      row({ path: "c/SKILL.md", name: "c" }),
    ]);
    const rows = await popularSkills(db, { limit: 2 });
    expect(rows).toHaveLength(2);
  });
});
