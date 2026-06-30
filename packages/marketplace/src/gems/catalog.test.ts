import { describe, it, expect } from "vitest";
import { GEMS, listGems, getGem, filterGems } from "./catalog";

describe("catalog", () => {
  it("listGems returns the seed (non-empty, unique keys)", () => {
    const gems = listGems();
    expect(gems.length).toBeGreaterThan(0);
    expect(new Set(gems.map((g) => g.key)).size).toBe(gems.length);
    expect(gems).toEqual(GEMS);
  });

  it("every gem has real-shaped ingredient ids (kind-prefixed)", () => {
    for (const g of GEMS) {
      expect(g.ingredients.length).toBeGreaterThan(0);
      for (const ing of g.ingredients) expect(ing.id.includes(":")).toBe(true);
    }
  });

  it("getGem hits and misses", () => {
    expect(getGem("brainstorming-kit")?.key).toBe("brainstorming-kit");
    expect(getGem("nope")).toBeUndefined();
  });

  it("filterGems matches key/description/tags case-insensitively, all on blank", () => {
    expect(filterGems(GEMS, "   ")).toEqual(GEMS);
    expect(filterGems(GEMS, "BRAINSTORM").some((g) => g.key === "brainstorming-kit")).toBe(true);
    expect(filterGems(GEMS, "github").some((g) => g.tags.includes("github") || g.key.includes("github"))).toBe(true);
    expect(filterGems(GEMS, "zzzznomatch")).toEqual([]);
  });
});
