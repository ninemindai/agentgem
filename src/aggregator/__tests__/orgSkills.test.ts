// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import {
  makeTestDb, upsertCuratedSkills, popularSkills, popularSkillGroups, skillNamesByTargetId,
  replaceOrgRepoSkills, deleteOrgRepoSkills, deleteOrgSkills, listOrgSkills, orgSkillExists,
  type CuratedSkillRow, type OrgSkillRow,
} from "@agentgem/aggregator";

const pub = (name: string): CuratedSkillRow => ({
  sourceId: "public-src", source: "Public", division: "eng", name, path: `eng/${name}/SKILL.md`,
  repo: "octo/public", homepage: null, stars: 5, installs: null, description: "public skill",
});
const priv = (name: string, repo = "acme/skills"): OrgSkillRow => ({
  sourceId: `org:${repo}`, path: `eng/${name}/SKILL.md`, division: "eng", name, repo, description: "internal",
});

describe("org-scoped curated skills", () => {
  it("replace/list/delete round-trips and scopes by (org, repo)", async () => {
    const db = await makeTestDb();
    await replaceOrgRepoSkills(db, "acme", "acme/skills", [priv("deploy"), priv("oncall")]);
    await replaceOrgRepoSkills(db, "acme", "acme/more", [priv("audit", "acme/more")]);
    expect((await listOrgSkills(db, "acme")).map((s) => s.name).sort()).toEqual(["audit", "deploy", "oncall"]);
    // replace drops rows missing from the new list (skill deleted upstream)
    await replaceOrgRepoSkills(db, "acme", "acme/skills", [priv("deploy")]);
    expect((await listOrgSkills(db, "acme")).map((s) => s.name).sort()).toEqual(["audit", "deploy"]);
    await deleteOrgRepoSkills(db, "acme", "acme/more");
    expect((await listOrgSkills(db, "acme")).map((s) => s.name)).toEqual(["deploy"]);
    await deleteOrgSkills(db, "acme");
    expect(await listOrgSkills(db, "acme")).toEqual([]);
  });

  it("orgSkillExists enforces the source∈scope boundary", async () => {
    const db = await makeTestDb();
    await replaceOrgRepoSkills(db, "acme", "acme/skills", [priv("deploy")]);
    expect(await orgSkillExists(db, "acme", "org:acme/skills", "eng/deploy/SKILL.md")).toBe(true);
    expect(await orgSkillExists(db, "globex", "org:acme/skills", "eng/deploy/SKILL.md")).toBe(false);
    expect(await orgSkillExists(db, "acme", "org:acme/skills", "eng/other/SKILL.md")).toBe(false);
  });

  it("private rows NEVER surface in public reads", async () => {
    const db = await makeTestDb();
    await upsertCuratedSkills(db, [pub("brainstorm")]);
    await replaceOrgRepoSkills(db, "acme", "acme/skills", [priv("deploy")]);
    expect((await popularSkills(db)).map((s) => s.name)).toEqual(["brainstorm"]);
    expect((await popularSkillGroups(db)).map((g) => g.sourceId)).toEqual(["public-src"]);
    const names = await skillNamesByTargetId(db, ["public-src/eng/brainstorm/SKILL.md", "org:acme/skills/eng/deploy/SKILL.md"]);
    expect(Object.keys(names)).toEqual(["public-src/eng/brainstorm/SKILL.md"]);
  });
});
