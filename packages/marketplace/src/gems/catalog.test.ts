import { describe, it, expect } from "vitest";
import { filterGems, STATIC_GEMS, loadGems, findGem, gameGenre, displayTags, filterGames, genreLabel } from "./catalog";
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
  it("dedupes artifactKinds into a kind summary (a 50-skill gem shows one 'skill' chip)", async () => {
    const dupey: RegistryGem = { key: "big-setup", version: "1.0.0", description: "d", tags: [], artifactKinds: Array(50).fill("skill") };
    const [g] = await loadGems(apiWith(() => Promise.resolve([dupey])));
    expect(g.artifactKinds).toEqual(["skill"]);
  });
  it("preserves distinct kinds and their first-seen order when deduping", async () => {
    const mixed: RegistryGem = { key: "mixed", version: "1.0.0", description: "d", tags: [], artifactKinds: ["skill", "mcp", "skill", "subagent", "mcp"] };
    const [g] = await loadGems(apiWith(() => Promise.resolve([mixed])));
    expect(g.artifactKinds).toEqual(["skill", "mcp", "subagent"]);
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
  it("loadGems threads RegistryGem.publishedBy → Gem.publishedBy", async () => {
    const live: RegistryGem = { key: "k", version: "1.0.0", description: "d", tags: [], artifactKinds: ["skill"], publishedBy: "rfeng" };
    const [g] = await loadGems(apiWith(() => Promise.resolve([live])));
    expect(g.publishedBy).toBe("rfeng");
  });
  it("a live gem with no publishedBy maps to an undefined Gem.publishedBy", async () => {
    const live: RegistryGem = { key: "k", version: "1.0.0", description: "d", tags: [], artifactKinds: [] };
    const [g] = await loadGems(apiWith(() => Promise.resolve([live])));
    expect(g.publishedBy).toBeUndefined();
  });
});

import type { Gem } from "./catalog";

const mkGem = (key: string, tags: string[], description = ""): Gem => ({
  key, version: "1.0.0", description, tags, artifactKinds: ["game"], ingredients: [],
});

describe("game genre + tag helpers", () => {
  it("gameGenre reads the genre value out of the tags array", () => {
    expect(gameGenre(mkGem("a", ["game", "replay", "puzzle"]))).toBe("replay");
    expect(gameGenre(mkGem("b", ["game", "session-heatmap"]))).toBe("session-heatmap");
  });

  it("gameGenre is undefined when no genre tag is present", () => {
    expect(gameGenre(mkGem("c", ["game", "puzzle"]))).toBeUndefined();
    expect(gameGenre(mkGem("d", []))).toBeUndefined();
  });

  it("displayTags strips the structural game tag and the genre tag", () => {
    expect(displayTags(mkGem("a", ["game", "replay", "puzzle", "coop"]))).toEqual(["puzzle", "coop"]);
    expect(displayTags(mkGem("b", ["game", "project-fun"]))).toEqual([]);
  });

  it("filterGames returns all games on a blank query and no genre facet", () => {
    const gs = [mkGem("a", ["game", "replay"]), mkGem("b", ["game", "project-fun"])];
    expect(filterGames(gs, "", []).length).toBe(2);
  });

  it("filterGames narrows by genre facet (OR within the facet)", () => {
    const gs = [mkGem("a", ["game", "replay"]), mkGem("b", ["game", "project-fun"]), mkGem("c", ["game", "replay"])];
    expect(filterGames(gs, "", ["replay"]).map((g) => g.key)).toEqual(["a", "c"]);
    expect(filterGames(gs, "", ["replay", "project-fun"]).length).toBe(3);
  });

  it("filterGames matches query over key, description, and display tags (not the structural tags)", () => {
    const gs = [
      mkGem("@me/duel", ["game", "replay", "puzzle"], "a coding duel"),
      mkGem("@me/heat", ["game", "session-heatmap"], "a heatmap"),
    ];
    expect(filterGames(gs, "puzzle", []).map((g) => g.key)).toEqual(["@me/duel"]);   // display tag
    expect(filterGames(gs, "heatmap", []).map((g) => g.key)).toEqual(["@me/heat"]);  // description
    expect(filterGames(gs, "duel", []).map((g) => g.key)).toEqual(["@me/duel"]);     // key
    expect(filterGames(gs, "game", []).length).toBe(0);      // "game" is structural, not searchable
  });

  it("filterGames AND-combines query and genre facet", () => {
    const gs = [mkGem("a", ["game", "replay", "puzzle"], "x"), mkGem("b", ["game", "project-fun", "puzzle"], "y")];
    expect(filterGames(gs, "puzzle", ["replay"]).map((g) => g.key)).toEqual(["a"]);
  });

  it("genreLabel maps known genres and passes through unknown", () => {
    expect(genreLabel("replay")).toBe("Session replay");
    expect(genreLabel("session-heatmap")).toBe("Session heatmap");
    expect(genreLabel("mystery")).toBe("mystery");
  });
});
