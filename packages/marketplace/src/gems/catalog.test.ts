import { describe, it, expect } from "vitest";
import { GEMS, listGems, getGem, filterGems, STATIC_GEMS, loadGems, findGem } from "./catalog";
import type { RegistryGem } from "../types";

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

const liveOne: RegistryGem = { key: "live-gem", version: "3.0.0", author: "acme", description: "live", tags: ["x"], artifactKinds: ["mcp"] };
const apiWith = (impl: () => Promise<RegistryGem[]>) => ({ getGems: impl }) as never;

describe("loadGems", () => {
  it("maps live registry gems to Gem with empty ingredients", async () => {
    const gems = await loadGems(apiWith(() => Promise.resolve([liveOne])));
    expect(gems).toEqual([{ key: "live-gem", version: "3.0.0", author: "acme", description: "live", tags: ["x"], artifactKinds: ["mcp"], ingredients: [] }]);
  });
  it("falls back to STATIC_GEMS when the live list is empty", async () => {
    expect(await loadGems(apiWith(() => Promise.resolve([])))).toEqual(STATIC_GEMS);
  });
  it("falls back to STATIC_GEMS when getGems throws", async () => {
    expect(await loadGems(apiWith(() => Promise.reject(new Error("net"))))).toEqual(STATIC_GEMS);
  });
});

describe("findGem", () => {
  it("hits and misses", () => {
    expect(findGem(STATIC_GEMS, STATIC_GEMS[0].key)?.key).toBe(STATIC_GEMS[0].key);
    expect(findGem(STATIC_GEMS, "nope")).toBeUndefined();
  });
});
