// src/gem/__tests__/registryPublish.test.ts
import { describe, it, expect } from "vitest";
import { publishGem, updateIndex } from "../registry.js";
import type { RegistryIndex, RegistryPublisher } from "../registry.js";
import type { FileTree } from "../targets.js";
import type { Gem } from "../types.js";

const gem: Gem = { name: "github-search", createdFrom: "/d", checks: [], requiredSecrets: [],
  artifacts: [{ type: "skill", name: "search", source: "standalone", content: "# Search" }] };

function capturingPublisher(): { publisher: RegistryPublisher; commits: { files: FileTree; message: string }[] } {
  const commits: { files: FileTree; message: string }[] = [];
  return { commits, publisher: { async putCommit(files, message) { commits.push({ files, message }); return { commit: "abc123" }; } } };
}

const empty: RegistryIndex = { formatVersion: 1, items: {} };

describe("publishGem", () => {
  it("writes the item archive + an updated index in one commit", async () => {
    const { publisher, commits } = capturingPublisher();
    const r = await publishGem({ gem, scope: "acme", version: "1.0.0", index: empty, publisher });
    expect(r.ref).toBe("@acme/github-search");
    expect(r.path).toBe("items/acme/github-search/1.0.0");
    expect(commits).toHaveLength(1);
    expect(commits[0].files["items/acme/github-search/1.0.0/gem.json"]).toBeDefined();
    const idx = JSON.parse(commits[0].files["registry.json"]) as RegistryIndex;
    expect(idx.items["@acme/github-search"].latest).toBe("1.0.0");
    expect(idx.items["@acme/github-search"].versions["1.0.0"].gemDigest).toBe(r.gemDigest);
  });

  it("is idempotent when re-publishing identical content at the same version", async () => {
    const { publisher } = capturingPublisher();
    const first = await publishGem({ gem, scope: "acme", version: "1.0.0", index: empty, publisher });
    const idx = updateIndex(empty, { key: "@acme/github-search", version: "1.0.0", path: first.path, gemDigest: first.gemDigest, dependencies: [] });
    await expect(publishGem({ gem, scope: "acme", version: "1.0.0", index: idx, publisher })).resolves.toMatchObject({ gemDigest: first.gemDigest });
  });

  it("refuses to overwrite an existing version with different content", async () => {
    const { publisher } = capturingPublisher();
    const idx = updateIndex(empty, { key: "@acme/github-search", version: "1.0.0", path: "items/acme/github-search/1.0.0", gemDigest: "sha256:OLD", dependencies: [] });
    await expect(publishGem({ gem, scope: "acme", version: "1.0.0", index: idx, publisher })).rejects.toThrow(/immutable|already published/i);
  });

  it("bumps latest only when the new version is higher", () => {
    let idx = updateIndex(empty, { key: "@a/x", version: "1.0.0", path: "p", gemDigest: "sha256:a", dependencies: [] });
    idx = updateIndex(idx, { key: "@a/x", version: "1.2.0", path: "p", gemDigest: "sha256:b", dependencies: [] });
    expect(idx.items["@a/x"].latest).toBe("1.2.0");
    idx = updateIndex(idx, { key: "@a/x", version: "1.1.0", path: "p", gemDigest: "sha256:c", dependencies: [] });
    expect(idx.items["@a/x"].latest).toBe("1.2.0");
  });
});
