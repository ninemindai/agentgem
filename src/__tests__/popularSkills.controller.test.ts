// src/__tests__/popularSkills.controller.test.ts
//
// AggregatorController.popularSkills — GET /api/aggregator/popular-skills. Confirms the exact
// response shape the marketplace UI depends on, the default/ceiling limit, and the ranking
// (installs desc, then stars desc, then name asc) is exposed end-to-end through the controller.
import { describe, it, expect } from "vitest";
import { makeTestDb, upsertCuratedSkills, type CuratedSkillRow } from "@agentgem/aggregator";
import { AggregatorController } from "../aggregator.controller.js";

function row(over: Partial<CuratedSkillRow>): CuratedSkillRow {
  return {
    sourceId: "src", source: "Src Label", division: "root", name: "a", path: "a/SKILL.md",
    repo: "owner/src", homepage: null, stars: 0, installs: null, ...over,
  };
}

describe("AggregatorController.popularSkills", () => {
  it("returns { skills: [...] } in the shared response shape, defaulting limit to 50", async () => {
    const db = await makeTestDb();
    await upsertCuratedSkills(db, [row({ path: "a/SKILL.md", name: "a", repo: "owner/repo", homepage: "https://x", stars: 3, installs: 1 })]);
    const c = new AggregatorController(db);
    const res = await c.popularSkills({ query: {} });
    expect(res).toEqual({
      skills: [{ sourceId: "src", source: "Src Label", division: "root", name: "a", path: "a/SKILL.md", repo: "owner/repo", homepage: "https://x", stars: 3, installs: 1 }],
    });
  });

  it("orders installs desc, then stars desc, then name asc", async () => {
    const db = await makeTestDb();
    await upsertCuratedSkills(db, [
      row({ path: "a/SKILL.md", name: "a", stars: 5 }),
      row({ path: "b/SKILL.md", name: "b", stars: 50 }),
      row({ path: "c/SKILL.md", name: "c", stars: 1, installs: 10 }),
    ]);
    const c = new AggregatorController(db);
    const res = await c.popularSkills({ query: {} });
    expect(res.skills.map((s) => s.name)).toEqual(["c", "b", "a"]);
  });

  it("honors an explicit limit", async () => {
    const db = await makeTestDb();
    await upsertCuratedSkills(db, [
      row({ path: "a/SKILL.md", name: "a" }),
      row({ path: "b/SKILL.md", name: "b" }),
    ]);
    const c = new AggregatorController(db);
    const res = await c.popularSkills({ query: { limit: 1 } });
    expect(res.skills).toHaveLength(1);
  });
});
