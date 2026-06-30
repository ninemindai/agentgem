import { describe, it, expect, vi } from "vitest";
import { mapIndexToGems, createGemCache } from "../gem/publicCatalog.js";

const index = {
  formatVersion: 1,
  items: {
    "@superpowers/brainstorming-kit": {
      latest: "1.2.0", versions: {},
      discovery: { author: "superpowers", description: "plan stuff", tags: ["planning"], artifactKinds: ["skill"] },
    },
    "@x/bare": { latest: "0.1.0", versions: {} },
  },
} as never;

describe("mapIndexToGems", () => {
  it("flattens index items to RegistryGem (version = latest, discovery spread, no ingredients field)", () => {
    const gems = mapIndexToGems(index);
    expect(gems).toContainEqual({ key: "@superpowers/brainstorming-kit", version: "1.2.0", author: "superpowers", description: "plan stuff", tags: ["planning"], artifactKinds: ["skill"] });
    expect(gems.find((g) => g.key === "@x/bare")).toEqual({ key: "@x/bare", version: "0.1.0", author: undefined, description: undefined, tags: undefined, artifactKinds: undefined });
    expect(gems.some((g) => "ingredients" in g)).toBe(false);
  });
});

describe("createGemCache", () => {
  it("returns [] when the source is null (unconfigured), ignoring any cached value", async () => {
    const c = createGemCache(1000);
    expect(await c.get(null, 0)).toEqual([]);
  });
  it("returns [] (not throw) when the source throws", async () => {
    const c = createGemCache(1000);
    expect(await c.get(() => Promise.reject(new Error("github down")), 0)).toEqual([]);
  });
  it("fetches once within the TTL window, refetches after it expires", async () => {
    const getIndex = vi.fn(() => Promise.resolve(index));
    const c = createGemCache(1000);
    await c.get(getIndex, 0);
    await c.get(getIndex, 500);
    expect(getIndex).toHaveBeenCalledTimes(1);
    await c.get(getIndex, 1500);
    expect(getIndex).toHaveBeenCalledTimes(2);
  });
});
