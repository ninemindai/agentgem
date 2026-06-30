// src/gem/__tests__/registryInstall.test.ts
import { describe, it, expect } from "vitest";
import { resolveInstall } from "@agentgem/distribute";
import type { RegistrySource, RegistryIndex } from "@agentgem/distribute";
import { writeGemArchive } from "@agentgem/archive";
import type { Gem } from "@agentgem/model";
import type { FileTree } from "@agentgem/model";

const root: Gem = { name: "github-search", createdFrom: "/d", checks: [], requiredSecrets: [],
  artifacts: [{ type: "skill", name: "search", source: "standalone", content: "# Search" }] };

function sourceFor(gem: Gem, version: string): RegistrySource {
  const { files } = writeGemArchive(gem, { version });
  const gemDigest = JSON.parse(files["gem.lock"]).gemDigest;
  const index: RegistryIndex = { formatVersion: 1, items: {
    "@acme/github-search": { latest: version, versions: { [version]: { path: "p/root", gemDigest, dependencies: [] } } },
  } };
  const store: Record<string, FileTree> = { "p/root": files };
  return { id: "fake", label: "fake", ready: () => true, async getIndex() { return index; }, async fetchItem(p) { return store[p]; } };
}

describe("resolveInstall", () => {
  it("returns a plan with a materialize preview for the chosen harness", async () => {
    const source = sourceFor(root, "1.0.0");
    const { plan, gem } = await resolveInstall({ refs: ["@acme/github-search"], mode: "materialize", target: "claude", source });
    expect(plan.items).toEqual([{ key: "@acme/github-search", version: "1.0.0" }]);
    expect(plan.totalArtifacts).toBe(1);
    expect(plan.materialize!.files["skills/search/SKILL.md"]).toContain("# Search");
    expect(gem.artifacts).toHaveLength(1);
  });

  it("omits the materialize preview in workspace mode", async () => {
    const source = sourceFor(root, "1.0.0");
    const { plan } = await resolveInstall({ refs: ["@acme/github-search"], mode: "workspace", source });
    expect(plan.materialize).toBeUndefined();
  });
});
