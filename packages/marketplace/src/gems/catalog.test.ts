import { describe, it, expect } from "vitest";
import { filterGems, STATIC_GEMS, loadGems, findGem } from "./catalog";
import type { RegistryGem } from "../types";
import { cutMeta } from "./cuts";

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

describe("cut threading", () => {
  it("loadGems maps RegistryGem.type → Gem.cut", async () => {
    const live: RegistryGem = { key: "k", version: "1.0.0", description: "d", tags: [], artifactKinds: ["mcp_server"], type: "integration" };
    const [g] = await loadGems(apiWith(() => Promise.resolve([live])));
    expect(g.cut).toBe("integration");
  });
  it("a live gem with no type maps to an undefined cut (no badge)", async () => {
    const live: RegistryGem = { key: "k", version: "1.0.0", description: "d", tags: [], artifactKinds: [] };
    const [g] = await loadGems(apiWith(() => Promise.resolve([live])));
    expect(g.cut).toBeUndefined();
  });
  it("every STATIC_GEM has a known cut", () => {
    for (const g of STATIC_GEMS) expect(cutMeta(g.cut)).not.toBeNull();
  });
  it("filterGems narrows by cut, AND-ed with search; empty cuts = all", () => {
    const gems = STATIC_GEMS;
    const integrations = filterGems(gems, "", ["integration"]);
    expect(integrations.length).toBeGreaterThan(0);
    expect(integrations.every((g) => g.cut === "integration")).toBe(true);
    expect(filterGems(gems, "", []).length).toBe(gems.length); // empty selection = all
  });
});
