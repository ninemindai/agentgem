// src/play/__tests__/genres.test.ts
import { describe, it, expect } from "vitest";
import { GENRES, genreFor, scaffoldFor } from "@agentgem/play";
import { GAME_GENRES } from "@agentgem/model";

describe("genres", () => {
  it("every declared genre is fully wired: GENRES entry, sourceKind, and a resolvable scaffold", () => {
    // Iterates GAME_GENRES so it cannot go stale the way the previous hand-listed version did. This is
    // what converts the three non-compile-enforced touchpoints (GENRES, SCAFFOLDS, sourceContext) into
    // a test failure instead of a runtime throw the first time a real user seeds the genre.
    for (const id of GAME_GENRES) {
      const spec = GENRES[id];
      expect(`${id}:${spec ? "spec" : "missing"}`).toBe(`${id}:spec`);
      expect(["session", "skill", "project", "html", "blank"]).toContain(spec.sourceKind);
      expect(() => scaffoldFor(spec.scaffold)).not.toThrow();
    }
  });
  it("genreFor resolves a known genre and throws on unknown", () => {
    expect(genreFor("replay").id).toBe("replay");
    expect(() => genreFor("bogus")).toThrow(/unknown genre/);
  });
  it("every genre names a non-empty scaffold and guidance", () => {
    for (const g of Object.values(GENRES)) {
      expect(g.scaffold.length).toBeGreaterThan(0);
      expect(g.guidance.length).toBeGreaterThan(0);
    }
  });
});
