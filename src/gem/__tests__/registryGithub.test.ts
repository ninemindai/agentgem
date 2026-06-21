// src/gem/__tests__/registryGithub.test.ts
import { describe, it, expect } from "vitest";
import { githubRegistrySource } from "../registryGithub.js";
import type { Http } from "../registryGithub.js";

// Minimal fake GitHub Contents API: directory listings return arrays; files return { content (base64) }.
function fakeHttp(tree: Record<string, string>): Http {
  return async (url) => {
    const m = /\/contents\/([^?]*)/.exec(url)!;
    const path = decodeURIComponent(m[1]);
    if (path === "registry.json" || tree[path] !== undefined) {
      return { status: 200, async text() { return JSON.stringify({ content: Buffer.from(tree[path]).toString("base64"), encoding: "base64" }); } };
    }
    // directory: return entries whose path is directly under `path`
    const entries = Object.keys(tree)
      .filter((p) => p.startsWith(path + "/"))
      .map((p) => ({ type: "file", path: p }));
    return { status: 200, async text() { return JSON.stringify(entries); } };
  };
}

describe("githubRegistrySource", () => {
  it("fetches and parses the index", async () => {
    const tree = { "registry.json": JSON.stringify({ formatVersion: 1, items: { "@a/x": { latest: "1.0.0", versions: {} } } }) };
    const src = githubRegistrySource({ repo: "o/r", ref: "main" }, fakeHttp(tree));
    const idx = await src.getIndex();
    expect(idx.items["@a/x"].latest).toBe("1.0.0");
  });

  it("fetches an item directory into a FileTree keyed by path relative to the item", async () => {
    const tree = {
      "items/a/x/1.0.0/gem.json": "{}",
      "items/a/x/1.0.0/skills/s/SKILL.md": "# S",
    };
    const src = githubRegistrySource({ repo: "o/r", ref: "main" }, fakeHttp(tree));
    const files = await src.fetchItem("items/a/x/1.0.0");
    expect(files["gem.json"]).toBe("{}");
    expect(files["skills/s/SKILL.md"]).toBe("# S");
  });
});
