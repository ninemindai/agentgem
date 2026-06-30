// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { mapIndexToGems } from "../publicCatalog.js";
import { defaultGemTypeRegistry, resolvePublishType } from "../gemTypeRegistry.js";
import type { RegistryIndex } from "@agentgem/distribute";

describe("mapIndexToGems — type", () => {
  it("surfaces discovery.type as RegistryGem.type", () => {
    const index: RegistryIndex = {
      formatVersion: 1,
      items: {
        "@a/x": {
          latest: "1.0.0",
          versions: { "1.0.0": { path: "p", gemDigest: "sha256:d", dependencies: [] } },
          discovery: { author: "a", artifactKinds: ["mcp_server"], type: "integration" },
        },
      },
    };
    expect(mapIndexToGems(index)[0].type).toBe("integration");
  });

  it("returns undefined when discovery.type is absent", () => {
    const index: RegistryIndex = {
      formatVersion: 1,
      items: {
        "@a/y": {
          latest: "1.0.0",
          versions: { "1.0.0": { path: "p", gemDigest: "sha256:d", dependencies: [] } },
          discovery: { author: "a", artifactKinds: ["mcp_server"] },
        },
      },
    };
    expect(mapIndexToGems(index)[0].type).toBeUndefined();
  });
});

describe("mapIndexToGems — publishedBy", () => {
  it("surfaces discovery.publishedBy as RegistryGem.publishedBy", () => {
    const index: RegistryIndex = { formatVersion: 1, items: {
      "@a/x": { latest: "1.0.0", versions: { "1.0.0": { path: "p", gemDigest: "sha256:d", dependencies: [] } },
        discovery: { author: "a", artifactKinds: ["skill"], publishedBy: "octocat" } },
    } };
    expect(mapIndexToGems(index)[0].publishedBy).toBe("octocat");
  });
});

describe("resolvePublishType", () => {
  it("defaults the type from derive when omitted, and rejects an unknown type", () => {
    const g = {
      name: "g",
      createdFrom: "t",
      artifacts: [{ type: "mcp_server", name: "m", transport: "stdio", config: {} }],
      checks: [],
      requiredSecrets: [],
    } as never;
    expect(resolvePublishType(defaultGemTypeRegistry, undefined, g)).toBe("integration");
    expect(resolvePublishType(defaultGemTypeRegistry, "skill", g)).toBe("skill"); // valid override
    expect(() => resolvePublishType(defaultGemTypeRegistry, "bogus", g)).toThrow(/unknown gem type/);
  });
});
