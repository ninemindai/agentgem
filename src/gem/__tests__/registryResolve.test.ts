// src/gem/__tests__/registryResolve.test.ts
import { describe, it, expect } from "vitest";
import { resolveGraph, selectVersion } from "../registry.js";
import type { RegistryIndex } from "../registry.js";

const idx: RegistryIndex = {
  formatVersion: 1,
  items: {
    "@a/root": { latest: "1.0.0", versions: { "1.0.0": { path: "items/a/root/1.0.0", gemDigest: "sha256:r", dependencies: ["@a/dep@^1.0.0"] } } },
    "@a/dep":  { latest: "1.2.0", versions: {
      "1.0.0": { path: "items/a/dep/1.0.0", gemDigest: "sha256:d0", dependencies: [] },
      "1.2.0": { path: "items/a/dep/1.2.0", gemDigest: "sha256:d2", dependencies: [] },
    } },
  },
};

describe("selectVersion", () => {
  it("picks the highest caret match", () => {
    expect(selectVersion(idx.items["@a/dep"], "^1.0.0")).toBe("1.2.0");
  });
  it("matches an exact version", () => {
    expect(selectVersion(idx.items["@a/dep"], "1.0.0")).toBe("1.0.0");
  });
  it("throws when nothing satisfies the range", () => {
    expect(() => selectVersion(idx.items["@a/dep"], "^2.0.0")).toThrow(/no version/i);
  });
});

describe("resolveGraph", () => {
  it("orders dependencies before dependents", () => {
    const g = resolveGraph(["@a/root"], idx);
    expect(g.map((n) => n.key)).toEqual(["@a/dep", "@a/root"]);
    expect(g.find((n) => n.key === "@a/dep")!.version).toBe("1.2.0");
  });
  it("dedupes a diamond into one node per key", () => {
    const diamond: RegistryIndex = { formatVersion: 1, items: {
      "@a/top": { latest: "1.0.0", versions: { "1.0.0": { path: "p/top", gemDigest: "sha256:t", dependencies: ["@a/l@^1.0.0", "@a/r@^1.0.0"] } } },
      "@a/l":   { latest: "1.0.0", versions: { "1.0.0": { path: "p/l", gemDigest: "sha256:l", dependencies: ["@a/base@^1.0.0"] } } },
      "@a/r":   { latest: "1.0.0", versions: { "1.0.0": { path: "p/r", gemDigest: "sha256:rr", dependencies: ["@a/base@^1.0.0"] } } },
      "@a/base":{ latest: "1.0.0", versions: { "1.0.0": { path: "p/base", gemDigest: "sha256:b", dependencies: [] } } },
    } };
    const keys = resolveGraph(["@a/top"], diamond).map((n) => n.key);
    expect(keys.filter((k) => k === "@a/base")).toHaveLength(1);
    expect(keys.indexOf("@a/base")).toBeLessThan(keys.indexOf("@a/top"));
  });
  it("throws on a dependency cycle", () => {
    const cyclic: RegistryIndex = { formatVersion: 1, items: {
      "@a/x": { latest: "1.0.0", versions: { "1.0.0": { path: "p/x", gemDigest: "sha256:x", dependencies: ["@a/y@^1.0.0"] } } },
      "@a/y": { latest: "1.0.0", versions: { "1.0.0": { path: "p/y", gemDigest: "sha256:y", dependencies: ["@a/x@^1.0.0"] } } },
    } };
    expect(() => resolveGraph(["@a/x"], cyclic)).toThrow(/cycle/i);
  });
  it("throws on an unknown item", () => {
    expect(() => resolveGraph(["@a/missing"], idx)).toThrow(/unknown item/i);
  });
  it("throws when latest points to a version absent from versions", () => {
    const malformed: RegistryIndex = { formatVersion: 1, items: {
      "@a/x": { latest: "2.0.0", versions: { "1.0.0": { path: "p/x", gemDigest: "sha256:x", dependencies: [] } } },
    } };
    expect(() => resolveGraph(["@a/x"], malformed)).toThrow(/version/i);
  });
  it("throws on incompatible ranges for the same item", () => {
    const conflict: RegistryIndex = { formatVersion: 1, items: {
      "@a/top": { latest: "1.0.0", versions: { "1.0.0": { path: "p/top", gemDigest: "sha256:t", dependencies: ["@a/dep@1.0.0", "@a/mid@^1.0.0"] } } },
      "@a/mid": { latest: "1.0.0", versions: { "1.0.0": { path: "p/mid", gemDigest: "sha256:m", dependencies: ["@a/dep@1.2.0"] } } },
      "@a/dep": { latest: "1.2.0", versions: {
        "1.0.0": { path: "p/dep0", gemDigest: "sha256:d0", dependencies: [] },
        "1.2.0": { path: "p/dep2", gemDigest: "sha256:d2", dependencies: [] },
      } },
    } };
    expect(() => resolveGraph(["@a/top"], conflict)).toThrow(/conflict/i);
  });
});
