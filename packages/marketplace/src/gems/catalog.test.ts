import { describe, it, expect } from "vitest";
import { filterGems, STATIC_GEMS, loadGems, findGem } from "./catalog";
import type { RegistryGem } from "../types";

describe("catalog", () => {
  it("STATIC_GEMS is non-empty with unique keys", () => {
    expect(STATIC_GEMS.length).toBeGreaterThan(0);
    expect(new Set(STATIC_GEMS.map((g) => g.key)).size).toBe(STATIC_GEMS.length);
  });

  it("every gem has real-shaped ingredient ids (kind-prefixed)", () => {
    for (const g of STATIC_GEMS) {
      expect(g.ingredients.length).toBeGreaterThan(0);
      for (const ing of g.ingredients) expect(ing.id.includes(":")).toBe(true);
    }
  });

  it("filterGems matches key/description/tags case-insensitively, all on blank", () => {
    expect(filterGems(STATIC_GEMS, "   ")).toEqual(STATIC_GEMS);
    expect(filterGems(STATIC_GEMS, "BRAINSTORM").some((g) => g.key === "brainstorming-kit")).toBe(true);
    expect(filterGems(STATIC_GEMS, "github").some((g) => g.tags.includes("github") || g.key.includes("github"))).toBe(true);
    expect(filterGems(STATIC_GEMS, "zzzznomatch")).toEqual([]);
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
