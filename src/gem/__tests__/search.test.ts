// src/gem/__tests__/search.test.ts
import { describe, it, expect } from "vitest";
import { searchIndex } from "@agentgem/distribute";
import type { RegistryIndex } from "@agentgem/distribute";

const index: RegistryIndex = {
  formatVersion: 1,
  items: {
    "@acme/github-search": {
      latest: "1.2.0",
      versions: { "1.2.0": { path: "items/acme/github-search/1.2.0", gemDigest: "sha256:a", dependencies: [] } },
      discovery: { description: "Search GitHub pull requests and issues", tags: ["github", "search"], author: "acme", artifactKinds: ["skill", "mcp_server"], updatedAt: "2026-01-01T00:00:00Z" },
    },
    "@acme/http-base": {
      latest: "1.0.0",
      versions: { "1.0.0": { path: "items/acme/http-base/1.0.0", gemDigest: "sha256:b", dependencies: [] } },
      discovery: { description: "Base HTTP client utilities", tags: ["http"], author: "acme", artifactKinds: ["mcp_server"], updatedAt: "2026-02-01T00:00:00Z" },
    },
    "@zeta/notes": {
      latest: "0.1.0",
      versions: { "0.1.0": { path: "items/zeta/notes/0.1.0", gemDigest: "sha256:c", dependencies: [] } },
      // no discovery metadata — must still be enumerable, just unranked
    },
  },
};

describe("searchIndex", () => {
  it("ranks a name match above a description-only match", () => {
    const hits = searchIndex(index, "github");
    expect(hits[0].key).toBe("@acme/github-search"); // name + tag + desc all hit
    expect(hits.map((h) => h.key)).not.toContain("@zeta/notes");
  });

  it("matches on tags and description", () => {
    expect(searchIndex(index, "http").map((h) => h.key)).toEqual(
      expect.arrayContaining(["@acme/http-base"]),
    );
  });

  it("returns latest + discovery fields on each hit", () => {
    const hit = searchIndex(index, "github")[0];
    expect(hit).toMatchObject({ key: "@acme/github-search", latest: "1.2.0", description: "Search GitHub pull requests and issues" });
    expect(hit.score).toBeGreaterThan(0);
  });

  it("filters by artifact kind", () => {
    const hits = searchIndex(index, "", { kind: "skill" });
    expect(hits.map((h) => h.key)).toEqual(["@acme/github-search"]);
  });

  it("empty query with no filter browses the whole catalog (incl. metadata-less gems)", () => {
    expect(searchIndex(index, "").map((h) => h.key).sort()).toEqual(
      ["@acme/github-search", "@acme/http-base", "@zeta/notes"],
    );
  });

  it("a non-matching query returns nothing", () => {
    expect(searchIndex(index, "kubernetes")).toEqual([]);
  });

  it("respects the limit option", () => {
    expect(searchIndex(index, "", { limit: 1 })).toHaveLength(1);
  });
});
