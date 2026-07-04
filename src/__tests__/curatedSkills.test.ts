// src/__tests__/curatedSkills.test.ts
//
// @agentgem/aggregator's curated_skills query module: bulk upsert (keyed on source_id+path,
// never overwriting `installs`) and popularSkills' ranking (installs desc, then stars desc, then
// name asc).
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, upsertCuratedSkills, popularSkills, popularSkillGroups, type CuratedSkillRow } from "@agentgem/aggregator";

function row(over: Partial<CuratedSkillRow>): CuratedSkillRow {
  return {
    sourceId: "src", source: "Src Label", division: "root", name: "a", path: "a/SKILL.md",
    repo: "owner/src", homepage: null, stars: 0, installs: null, description: null, ...over,
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

  it("upserts on (sourceId, path): re-indexing updates stars/name/division/description but never installs", async () => {
    const db = await makeTestDb();
    await upsertCuratedSkills(db, [row({ path: "x/SKILL.md", name: "x", stars: 1, installs: null, description: "old desc" })]);
    // Simulate a later skills.sh enrichment setting installs directly (out of band from the
    // indexer, which never writes this column) — raw SQL, not upsertCuratedSkills, since that
    // function intentionally cannot set installs.
    await db.execute(sql`update curated_skills set installs = 42 where source_id = 'src' and path = 'x/SKILL.md'`);
    let rows = await popularSkills(db, { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stars: 1, installs: 42, description: "old desc" });

    // Re-index with new stars/name/division/description for the same key: installs must survive
    // untouched, but description (unlike installs) DOES get overwritten.
    await upsertCuratedSkills(db, [row({ path: "x/SKILL.md", name: "renamed", division: "eng", stars: 99, installs: null, description: "new desc" })]);
    rows = await popularSkills(db, { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "renamed", division: "eng", stars: 99, installs: 42, description: "new desc" });
  });

  it("returns the exact response shape (sourceId/source/division/name/path/repo/homepage/stars/installs/description)", async () => {
    const db = await makeTestDb();
    await upsertCuratedSkills(db, [row({ path: "y/SKILL.md", name: "y", source: "The Source", repo: "owner/repo", homepage: "https://example.com", stars: 7, description: "does y things" })]);
    const rows = await popularSkills(db, { limit: 10 });
    expect(rows[0]).toEqual({
      sourceId: "src", source: "The Source", division: "root", name: "y", path: "y/SKILL.md",
      repo: "owner/repo", homepage: "https://example.com", stars: 7, installs: null, description: "does y things",
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

describe("popularSkillGroups", () => {
  it("groups by source, ordered by the source's stars desc; within a group installs desc then name asc", async () => {
    const db = await makeTestDb();
    await upsertCuratedSkills(db, [
      row({ sourceId: "low-star", source: "Low Star Source", repo: "owner/low", stars: 5, path: "a/SKILL.md", name: "a", description: "a desc" }),
      row({ sourceId: "high-star", source: "High Star Source", repo: "owner/high", stars: 500, path: "z/SKILL.md", name: "z", installs: 3 }),
      row({ sourceId: "high-star", source: "High Star Source", repo: "owner/high", stars: 500, path: "y/SKILL.md", name: "y", installs: 10 }),
      row({ sourceId: "high-star", source: "High Star Source", repo: "owner/high", stars: 500, path: "x/SKILL.md", name: "x", installs: 10 }), // ties "y" on installs -> name asc
    ]);
    const groups = await popularSkillGroups(db);
    expect(groups.map((g) => g.sourceId)).toEqual(["high-star", "low-star"]);
    expect(groups[0]).toMatchObject({ source: "High Star Source", repo: "owner/high", stars: 500 });
    expect(groups[0]!.skills.map((s) => s.name)).toEqual(["x", "y", "z"]);
    expect(groups[1]!.skills[0]).toMatchObject({ name: "a", description: "a desc" });
  });

  it("caps groups to `sources` and skills to `perSource`", async () => {
    const db = await makeTestDb();
    await upsertCuratedSkills(db, [
      row({ sourceId: "s1", repo: "o/s1", stars: 30, path: "a/SKILL.md", name: "a" }),
      row({ sourceId: "s1", repo: "o/s1", stars: 30, path: "b/SKILL.md", name: "b" }),
      row({ sourceId: "s1", repo: "o/s1", stars: 30, path: "c/SKILL.md", name: "c" }),
      row({ sourceId: "s2", repo: "o/s2", stars: 20, path: "d/SKILL.md", name: "d" }),
      row({ sourceId: "s3", repo: "o/s3", stars: 10, path: "e/SKILL.md", name: "e" }),
    ]);
    const groups = await popularSkillGroups(db, { sources: 2, perSource: 2 });
    expect(groups.map((g) => g.sourceId)).toEqual(["s1", "s2"]);
    expect(groups[0]!.skills).toHaveLength(2);
  });
});
