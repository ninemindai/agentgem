// src/gem/__tests__/registryMerge.test.ts
import { describe, it, expect } from "vitest";
import { mergeGems } from "../registry.js";
import type { ResolvedNode, RegistrySource } from "../registry.js";
import { writeGemArchive } from "../archive.js";
import type { Gem } from "../types.js";
import type { FileTree } from "../targets.js";

// Build an in-memory source: item path -> archive FileTree, prefixed under the item path.
function fakeSource(items: Record<string, { gem: Gem; version: string }>): { source: RegistrySource; nodes: ResolvedNode[] } {
  const store: Record<string, FileTree> = {};
  for (const [path, { gem, version }] of Object.entries(items)) {
    const { files } = writeGemArchive(gem, { version });
    store[path] = files;
  }
  const source: RegistrySource = {
    id: "fake", label: "fake", ready: () => true,
    async getIndex() { return { formatVersion: 1, items: {} }; },
    async fetchItem(path) { return store[path]; },
  };
  return { source, nodes: [] } as any;
}

const dep: Gem = { name: "http-base", createdFrom: "/d", checks: [], requiredSecrets: [{ name: "TOKEN", artifact: "http", location: "headers.authorization" }],
  artifacts: [{ type: "skill", name: "http", source: "standalone", content: "# HTTP base" }] };
const root: Gem = { name: "github-search", createdFrom: "/d", checks: [], requiredSecrets: [],
  artifacts: [{ type: "skill", name: "search", source: "standalone", content: "# Search" }] };

describe("mergeGems", () => {
  it("merges dependency + dependent artifacts and unions requiredSecrets", async () => {
    const { source } = fakeSource({ "p/dep": { gem: dep, version: "1.0.0" }, "p/root": { gem: root, version: "1.0.0" } });
    const nodes: ResolvedNode[] = [
      { key: "@a/http-base", version: "1.0.0", path: "p/dep", gemDigest: await digestOf(source, "p/dep"), deps: [] },
      { key: "@a/github-search", version: "1.0.0", path: "p/root", gemDigest: await digestOf(source, "p/root"), deps: ["@a/http-base"] },
    ];
    const { gem, provenance } = await mergeGems(nodes, source);
    expect(gem.artifacts.map((a) => a.name).sort()).toEqual(["http", "search"]);
    expect(gem.requiredSecrets).toEqual([{ name: "TOKEN", artifact: "http", location: "headers.authorization" }]);
    expect(provenance.items.map((i) => i.key)).toEqual(["@a/http-base", "@a/github-search"]);
  });

  it("lets a dependent override an ancestor's same-named artifact", async () => {
    const baseGem: Gem = { name: "b", createdFrom: "/d", checks: [], requiredSecrets: [], artifacts: [{ type: "skill", name: "review", source: "standalone", content: "# base review" }] };
    const overrideGem: Gem = { name: "o", createdFrom: "/d", checks: [], requiredSecrets: [], artifacts: [{ type: "skill", name: "review", source: "standalone", content: "# local review" }] };
    const { source } = fakeSource({ "p/base": { gem: baseGem, version: "1.0.0" }, "p/over": { gem: overrideGem, version: "1.0.0" } });
    const nodes: ResolvedNode[] = [
      { key: "@a/base", version: "1.0.0", path: "p/base", gemDigest: await digestOf(source, "p/base"), deps: [] },
      { key: "@a/over", version: "1.0.0", path: "p/over", gemDigest: await digestOf(source, "p/over"), deps: ["@a/base"] },
    ];
    const { gem, provenance } = await mergeGems(nodes, source);
    const review = gem.artifacts.find((a) => a.name === "review")!;
    expect((review as any).content).toContain("local review");
    expect(provenance.overrides).toEqual([{ artifact: "review", winner: "@a/over", loser: "@a/base" }]);
  });

  it("errors on a same-name/different-content collision between unrelated siblings", async () => {
    const lGem: Gem = { name: "l", createdFrom: "/d", checks: [], requiredSecrets: [], artifacts: [{ type: "skill", name: "dup", source: "standalone", content: "# left" }] };
    const rGem: Gem = { name: "r", createdFrom: "/d", checks: [], requiredSecrets: [], artifacts: [{ type: "skill", name: "dup", source: "standalone", content: "# right" }] };
    const { source } = fakeSource({ "p/l": { gem: lGem, version: "1.0.0" }, "p/r": { gem: rGem, version: "1.0.0" } });
    const nodes: ResolvedNode[] = [
      { key: "@a/l", version: "1.0.0", path: "p/l", gemDigest: await digestOf(source, "p/l"), deps: [] },
      { key: "@a/r", version: "1.0.0", path: "p/r", gemDigest: await digestOf(source, "p/r"), deps: [] },
    ];
    await expect(mergeGems(nodes, source)).rejects.toThrow(/collision/i);
  });

  it("silently dedups same-name/same-content artifacts from unrelated siblings", async () => {
    const sharedContent = "# shared skill";
    const lGem: Gem = { name: "l", createdFrom: "/d", checks: [], requiredSecrets: [], artifacts: [{ type: "skill", name: "shared", source: "standalone", content: sharedContent }] };
    const rGem: Gem = { name: "r", createdFrom: "/d", checks: [], requiredSecrets: [], artifacts: [{ type: "skill", name: "shared", source: "standalone", content: sharedContent }] };
    const { source } = fakeSource({ "p/l": { gem: lGem, version: "1.0.0" }, "p/r": { gem: rGem, version: "1.0.0" } });
    const nodes: ResolvedNode[] = [
      { key: "@a/l", version: "1.0.0", path: "p/l", gemDigest: await digestOf(source, "p/l"), deps: [] },
      { key: "@a/r", version: "1.0.0", path: "p/r", gemDigest: await digestOf(source, "p/r"), deps: [] },
    ];
    const { gem, provenance } = await mergeGems(nodes, source);
    expect(gem.artifacts.filter((a) => a.name === "shared")).toHaveLength(1);
    expect(provenance.overrides).toEqual([]);
  });

  it("rejects an archive whose digest disagrees with the resolved node", async () => {
    const { source } = fakeSource({ "p/root": { gem: root, version: "1.0.0" } });
    const nodes: ResolvedNode[] = [{ key: "@a/github-search", version: "1.0.0", path: "p/root", gemDigest: "sha256:WRONG", deps: [] }];
    await expect(mergeGems(nodes, source)).rejects.toThrow(/digest/i);
  });
  it("errors on a same-name/different-content check collision between unrelated siblings", async () => {
    const checkA = { kind: "behavioral" as const, name: "lint", task: "run lint", assertions: [] };
    const checkB = { kind: "behavioral" as const, name: "lint", task: "run lint --strict", assertions: [] };
    const lGem: Gem = { name: "l", createdFrom: "/d", checks: [checkA], requiredSecrets: [], artifacts: [] };
    const rGem: Gem = { name: "r", createdFrom: "/d", checks: [checkB], requiredSecrets: [], artifacts: [] };
    const { source } = fakeSource({ "p/l": { gem: lGem, version: "1.0.0" }, "p/r": { gem: rGem, version: "1.0.0" } });
    const nodes: ResolvedNode[] = [
      { key: "@a/l", version: "1.0.0", path: "p/l", gemDigest: await digestOf(source, "p/l"), deps: [] },
      { key: "@a/r", version: "1.0.0", path: "p/r", gemDigest: await digestOf(source, "p/r"), deps: [] },
    ];
    await expect(mergeGems(nodes, source)).rejects.toThrow(/collision/i);
  });

  it("dedups same-name/same-content checks from ancestor and dependent", async () => {
    const sharedCheck = { kind: "behavioral" as const, name: "lint", task: "run lint", assertions: [] };
    const baseGem: Gem = { name: "b", createdFrom: "/d", checks: [sharedCheck], requiredSecrets: [], artifacts: [] };
    const depGem: Gem = { name: "d", createdFrom: "/d", checks: [sharedCheck], requiredSecrets: [], artifacts: [] };
    const { source } = fakeSource({ "p/base": { gem: baseGem, version: "1.0.0" }, "p/dep": { gem: depGem, version: "1.0.0" } });
    const nodes: ResolvedNode[] = [
      { key: "@a/base", version: "1.0.0", path: "p/base", gemDigest: await digestOf(source, "p/base"), deps: [] },
      { key: "@a/dep", version: "1.0.0", path: "p/dep", gemDigest: await digestOf(source, "p/dep"), deps: ["@a/base"] },
    ];
    const { gem } = await mergeGems(nodes, source);
    expect(gem.checks.filter((c) => c.name === "lint")).toHaveLength(1);
  });

  it("throws a descriptive error when gem.lock is missing from the archive", async () => {
    const fakeNode: ResolvedNode = { key: "@a/broken", version: "1.0.0", path: "p/broken", gemDigest: "sha256:fake", deps: [] };
    const source: RegistrySource = {
      id: "fake", label: "fake", ready: () => true,
      async getIndex() { return { formatVersion: 1, items: {} }; },
      async fetchItem() { return { "gem.json": "{}" }; }, // no gem.lock
    };
    await expect(mergeGems([fakeNode], source)).rejects.toThrow(/missing gem\.lock/i);
  });

});

async function digestOf(source: RegistrySource, path: string): Promise<string> {
  const files = await source.fetchItem(path);
  return JSON.parse(files["gem.lock"]).gemDigest;
}
