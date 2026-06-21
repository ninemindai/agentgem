// src/gem/__tests__/registryGithub.test.ts
import { describe, it, expect } from "vitest";
import { githubRegistrySource, githubRegistryPublisher } from "../registryGithub.js";
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

  it("recursively descends through nested subdirectory entries (type: dir) to reach deep files", async () => {
    // Tree has a file at items/a/x/1.0.0/sub/deep/file.txt.
    // The fake must return type:"dir" for intermediate paths so walk() recurses properly.
    const deepTree: Record<string, string> = {
      "items/a/x/1.0.0/sub/deep/file.txt": "deep",
    };
    // Enhanced fake that returns type:"dir" for intermediate directories
    const deepFakeHttp: Http = async (url) => {
      const m = /\/contents\/([^?]*)/.exec(url)!;
      const path = decodeURIComponent(m[1]);
      if (deepTree[path] !== undefined) {
        return { status: 200, async text() { return JSON.stringify({ content: Buffer.from(deepTree[path]).toString("base64"), encoding: "base64" }); } };
      }
      // Find all keys nested under this path
      const children = Object.keys(deepTree).filter((p) => p.startsWith(path + "/"));
      // For each direct child (one level below path), emit either a dir or file entry
      const seen = new Set<string>();
      const entries: { type: string; path: string }[] = [];
      for (const p of children) {
        const rest = p.slice(path.length + 1);
        const slash = rest.indexOf("/");
        if (slash === -1) {
          // Direct file child
          if (!seen.has(p)) { seen.add(p); entries.push({ type: "file", path: p }); }
        } else {
          // Intermediate directory child
          const dirPath = path + "/" + rest.slice(0, slash);
          if (!seen.has(dirPath)) { seen.add(dirPath); entries.push({ type: "dir", path: dirPath }); }
        }
      }
      return { status: 200, async text() { return JSON.stringify(entries); } };
    };
    const src = githubRegistrySource({ repo: "o/r", ref: "main" }, deepFakeHttp);
    const files = await src.fetchItem("items/a/x/1.0.0");
    expect(files["sub/deep/file.txt"]).toBe("deep");
  });
});

describe("githubRegistryPublisher", () => {
  it("putCommit drives blobs → tree → commit → ref-update in order, using singular GET and plural PATCH for refs", async () => {
    // Records every (method, path-suffix) pair in sequence so we can assert ordering and endpoint shape.
    const requests: { method: string; path: string }[] = [];
    let blobCounter = 0;

    const fakePubHttp: Http = async (url, init) => {
      const method = init?.method ?? "GET";
      // Extract the path after /repos/o/r/
      const m = /\/repos\/o\/r\/(.*)/.exec(url)!;
      const path = m[1].split("?")[0]; // strip query string
      requests.push({ method, path });

      if (method === "GET" && path === "git/ref/heads/main") {
        return { status: 200, async text() { return JSON.stringify({ object: { sha: "base-sha" } }); } };
      }
      if (method === "GET" && path === "git/commits/base-sha") {
        return { status: 200, async text() { return JSON.stringify({ tree: { sha: "base-tree" } }); } };
      }
      if (method === "POST" && path === "git/blobs") {
        const sha = `blob-${blobCounter++}`;
        return { status: 201, async text() { return JSON.stringify({ sha }); } };
      }
      if (method === "POST" && path === "git/trees") {
        return { status: 201, async text() { return JSON.stringify({ sha: "new-tree" }); } };
      }
      if (method === "POST" && path === "git/commits") {
        return { status: 201, async text() { return JSON.stringify({ sha: "new-commit" }); } };
      }
      if (method === "PATCH" && path === "git/refs/heads/main") {
        return { status: 200, async text() { return JSON.stringify({ ref: "refs/heads/main", object: { sha: "new-commit" } }); } };
      }
      throw new Error(`Unexpected fake request: ${method} ${path}`);
    };

    const cfg = { repo: "o/r", ref: "main", token: "t" };
    const publisher = githubRegistryPublisher(cfg, fakePubHttp);
    const result = await publisher.putCommit({ "registry.json": "{}", "items/a/x/1.0.0/gem.json": "{}" }, "msg");

    // 1. The resolved commit sha must be returned
    expect(result).toEqual({ commit: "new-commit" });

    // 2. Assert singular GET vs plural PATCH — the key API asymmetry
    const getRef = requests.find((r) => r.method === "GET" && r.path.includes("git/ref/heads/main"));
    expect(getRef).toBeDefined();
    expect(getRef!.path).toMatch(/^git\/ref\/heads\/main$/); // singular "ref"

    const patchRef = requests.find((r) => r.method === "PATCH" && r.path.includes("git/refs/heads/main"));
    expect(patchRef).toBeDefined();
    expect(patchRef!.path).toMatch(/^git\/refs\/heads\/main$/); // plural "refs"

    // 3. Assert sequencing: 2 blob POSTs, then tree POST, then commit POST, then PATCH
    const methodPaths = requests.map((r) => `${r.method} ${r.path}`);
    const blobIdxs = methodPaths.map((mp, i) => (mp === "POST git/blobs" ? i : -1)).filter((i) => i >= 0);
    expect(blobIdxs).toHaveLength(2); // one blob per file

    const treeIdx = methodPaths.indexOf("POST git/trees");
    const commitIdx = methodPaths.indexOf("POST git/commits");
    const patchIdx = methodPaths.indexOf("PATCH git/refs/heads/main");

    // All blobs before tree
    for (const bi of blobIdxs) expect(bi).toBeLessThan(treeIdx);
    // tree before commit
    expect(treeIdx).toBeLessThan(commitIdx);
    // commit before PATCH ref
    expect(commitIdx).toBeLessThan(patchIdx);
  });
});
