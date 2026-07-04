// src/__tests__/curatedSkillsIndexer.test.ts
//
// indexCuratedSkills bridges @agentgem/distribute's curated-source adapters into the aggregator
// DB. Exercised here with a fake CURATED_SOURCES list + a fake Http (no real network), covering
// both adapter kinds (skills-layout tree listing, agency-layout divisions+agents) and the
// per-source failure isolation (one bad repo must not sink the whole run).
import { describe, it, expect } from "vitest";
import { makeTestDb, popularSkills } from "@agentgem/aggregator";
import type { CuratedSource, Http } from "@agentgem/distribute";
import { indexCuratedSkills } from "../curatedSkillsIndexer.js";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

const SKILLS_SOURCE: CuratedSource = {
  id: "skills-repo", label: "Skills Repo", description: "d", repo: "owner/skills-repo", ref: "main", kind: "skills-layout",
  homepage: "https://github.com/owner/skills-repo",
};
const AGENCY_SOURCE: CuratedSource = {
  id: "agency-repo", label: "Agency Repo", description: "d", repo: "owner/agency-repo", ref: "main", kind: "agency-layout",
};
const BROKEN_SOURCE: CuratedSource = {
  id: "broken-repo", label: "Broken Repo", description: "d", repo: "owner/broken-repo", ref: "main", kind: "skills-layout",
};

const SKILL_MD = `---\nname: ask-matt\ndescription: Ask Matt anything.\n---\nbody`;
const AGENT_MD = `---\nname: Frontend Developer\ndescription: Builds frontend UI.\n---\nbody`;

function fakeHttp(): Http {
  return async (url) => {
    if (url === "https://api.github.com/repos/owner/skills-repo") {
      return { status: 200, text: async () => JSON.stringify({ stargazers_count: 42 }) };
    }
    if (url === "https://api.github.com/repos/owner/agency-repo") {
      return { status: 200, text: async () => JSON.stringify({ stargazers_count: 7 }) };
    }
    if (url === "https://api.github.com/repos/owner/broken-repo") {
      return { status: 403, text: async () => "rate limited" };
    }
    if (url.includes("/repos/owner/skills-repo/git/trees/")) {
      return { status: 200, text: async () => JSON.stringify({ tree: [{ path: "eng/ask-matt/SKILL.md", type: "blob" }] }) };
    }
    if (url.includes("/repos/owner/broken-repo/git/trees/")) {
      return { status: 404, text: async () => "not found" };
    }
    if (url.includes("/repos/owner/agency-repo/contents/divisions.json")) {
      return { status: 200, text: async () => JSON.stringify({ content: b64(JSON.stringify({ divisions: { engineering: { label: "Engineering" } } })), encoding: "base64" }) };
    }
    if (url.includes("/repos/owner/agency-repo/contents/engineering?")) {
      return { status: 200, text: async () => JSON.stringify([{ type: "file", name: "engineering-frontend-developer.md", path: "engineering/engineering-frontend-developer.md" }]) };
    }
    if (url.includes("/repos/owner/skills-repo/contents/eng/ask-matt/SKILL.md")) {
      return { status: 200, text: async () => JSON.stringify({ content: b64(SKILL_MD), encoding: "base64" }) };
    }
    if (url.includes("/repos/owner/agency-repo/contents/engineering/engineering-frontend-developer.md")) {
      return { status: 200, text: async () => JSON.stringify({ content: b64(AGENT_MD), encoding: "base64" }) };
    }
    return { status: 404, text: async () => `no fake route for ${url}` };
  };
}

describe("indexCuratedSkills", () => {
  it("indexes a skills-layout source: stars + skill list + description upserted", async () => {
    const db = await makeTestDb();
    const r = await indexCuratedSkills(db, { sources: [SKILLS_SOURCE], http: fakeHttp() });
    expect(r).toEqual({ sources: 1, skills: 1 });
    const rows = await popularSkills(db, { limit: 10 });
    expect(rows).toEqual([{
      sourceId: "skills-repo", source: "Skills Repo", division: "eng", name: "ask-matt", path: "eng/ask-matt/SKILL.md",
      repo: "owner/skills-repo", homepage: "https://github.com/owner/skills-repo", stars: 42, installs: null,
      description: "Ask Matt anything.",
    }]);
  });

  it("indexes an agency-layout source via divisions+agents, with description", async () => {
    const db = await makeTestDb();
    const r = await indexCuratedSkills(db, { sources: [AGENCY_SOURCE], http: fakeHttp() });
    expect(r).toEqual({ sources: 1, skills: 1 });
    const rows = await popularSkills(db, { limit: 10 });
    expect(rows[0]).toMatchObject({ sourceId: "agency-repo", division: "engineering", stars: 7, homepage: null, description: "Builds frontend UI." });
  });

  it("indexes a skill with description: null when its sourceEntry fetch fails (per-skill isolation)", async () => {
    const db = await makeTestDb();
    const flakyEntryHttp: Http = async (url, init) => {
      if (url.includes("/repos/owner/skills-repo/contents/eng/ask-matt/SKILL.md")) throw new Error("rate limited");
      return fakeHttp()(url, init);
    };
    const r = await indexCuratedSkills(db, { sources: [SKILLS_SOURCE], http: flakyEntryHttp });
    expect(r).toEqual({ sources: 1, skills: 1 }); // the skill is still indexed, just without a description
    const rows = await popularSkills(db, { limit: 10 });
    expect(rows[0]).toMatchObject({ name: "ask-matt", description: null });
  });

  it("skips a broken source's skill listing but keeps indexing the rest (failure isolation)", async () => {
    const db = await makeTestDb();
    const r = await indexCuratedSkills(db, { sources: [BROKEN_SOURCE, SKILLS_SOURCE], http: fakeHttp() });
    expect(r).toEqual({ sources: 1, skills: 1 }); // only skills-repo counted; broken-repo skipped entirely
    const rows = await popularSkills(db, { limit: 10 });
    expect(rows.map((row) => row.sourceId)).toEqual(["skills-repo"]);
  });

  it("defaults stars to 0 when the GitHub stars call itself fails, without dropping the skills", async () => {
    const db = await makeTestDb();
    const flakyStarsHttp: Http = async (url, init) => {
      if (url === "https://api.github.com/repos/owner/skills-repo") throw new Error("network down");
      return fakeHttp()(url, init);
    };
    const r = await indexCuratedSkills(db, { sources: [SKILLS_SOURCE], http: flakyStarsHttp });
    expect(r).toEqual({ sources: 1, skills: 1 });
    const rows = await popularSkills(db, { limit: 10 });
    expect(rows[0]).toMatchObject({ stars: 0 });
  });
});
