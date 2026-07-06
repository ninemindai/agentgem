// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { makeTestDb, listOrgSkills } from "@agentgem/aggregator";
import type { Http } from "@agentgem/distribute";
import { indexOrgRepo } from "../orgIndexer.js";

const b64 = (s: string) => Buffer.from(s).toString("base64");
const skillMd = (name: string, desc: string) => `---\nname: ${name}\ndescription: ${desc}\n---\nbody`;

// Fake GitHub: one tree listing + per-file contents. Asserts the installation token is sent.
function fakeRepoHttp(files: Record<string, string>, seenAuth: string[] = []): Http {
  return async (url, init) => {
    seenAuth.push(String((init?.headers as Record<string, string>)?.Authorization ?? ""));
    if (url.includes("/git/trees/")) {
      const tree = Object.keys(files).map((path) => ({ path, type: "blob" }));
      return { status: 200, text: async () => JSON.stringify({ tree }) };
    }
    const path = decodeURIComponent(url.split("/contents/")[1]?.split("?")[0] ?? "");
    if (files[path]) return { status: 200, text: async () => JSON.stringify({ content: b64(files[path]), encoding: "base64" }) };
    return { status: 404, text: async () => "{}" };
  };
}

describe("indexOrgRepo", () => {
  it("indexes SKILL.md metadata (frontmatter name+description), token on every call", async () => {
    const db = await makeTestDb();
    const seen: string[] = [];
    const http = fakeRepoHttp({
      "eng/deploy/SKILL.md": skillMd("deploy-runbook", "How we deploy"),
      "eng/oncall/SKILL.md": skillMd("oncall", "Oncall playbook"),
      "README.md": "not a skill",
    }, seen);
    const n = await indexOrgRepo(db, http, "tok-1", "Acme", "acme/skills", "main");
    expect(n).toBe(2);
    const rows = await listOrgSkills(db, "acme");
    expect(rows.map((r) => ({ name: r.name, sourceId: r.sourceId, description: r.description }))).toEqual([
      { name: "deploy-runbook", sourceId: "org:acme/skills", description: "How we deploy" },
      { name: "oncall", sourceId: "org:acme/skills", description: "Oncall playbook" },
    ]);
    expect(seen.every((a) => a === "Bearer tok-1")).toBe(true);
  });

  it("a failing entry fetch indexes with null description; re-index drops removed skills", async () => {
    const db = await makeTestDb();
    // First index: two skills, one body 404s (metadata still indexed via path-derived name).
    let http = fakeRepoHttp({ "eng/deploy/SKILL.md": skillMd("deploy", "d") });
    const treeOnly: Http = async (url, init) => {
      if (url.includes("/git/trees/")) return { status: 200, text: async () => JSON.stringify({ tree: [{ path: "eng/deploy/SKILL.md", type: "blob" }, { path: "eng/gone/SKILL.md", type: "blob" }] }) };
      return http(url, init);
    };
    expect(await indexOrgRepo(db, treeOnly, "t", "acme", "acme/skills", "main")).toBe(2);
    expect((await listOrgSkills(db, "acme")).find((r) => r.name === "gone")?.description).toBeNull();
    // Second index: repo now has only deploy → gone disappears.
    expect(await indexOrgRepo(db, http, "t", "acme", "acme/skills", "main")).toBe(1);
    expect((await listOrgSkills(db, "acme")).map((r) => r.name)).toEqual(["deploy"]);
  });
});
