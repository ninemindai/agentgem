// src/play/__tests__/genres.test.ts
import { describe, it, expect } from "vitest";
import { GENRES, genreFor } from "@agentgem/play";

describe("genres", () => {
  it("has the four genres, each mapping to its source kind", () => {
    expect(Object.keys(GENRES).sort()).toEqual(["project-fun", "replay", "session-heatmap", "skill-run"]);
    expect(GENRES.replay.sourceKind).toBe("session");
    expect(GENRES["skill-run"].sourceKind).toBe("skill");
    expect(GENRES["project-fun"].sourceKind).toBe("project");
    expect(GENRES["session-heatmap"].sourceKind).toBe("session");
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
