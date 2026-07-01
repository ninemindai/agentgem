// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { mapDbToGems, mergeGems, mapIndexToGems, safeDbGems } from "../gem/publicCatalog.js";
import type { RegistryIndex } from "@agentgem/distribute";

describe("publicCatalog merge", () => {
  it("maps DB rows as non-installable", () => {
    const gems = mapDbToGems([{ gemKey: "@o/k", version: "1.0.0", publishedBy: "o", description: "d", createdAtMs: 1 }]);
    expect(gems[0]).toMatchObject({ key: "@o/k", version: "1.0.0", installable: false, publishedBy: "o" });
  });

  it("marks registry index gems installable", () => {
    const index = { items: { "@o/k": { latest: "2.0.0", discovery: { description: "r" } } } } as unknown as RegistryIndex;
    expect(mapIndexToGems(index)[0]).toMatchObject({ key: "@o/k", installable: true });
  });

  it("DB wins on key collision", () => {
    const db = mapDbToGems([{ gemKey: "@o/k", version: "1.0.0", publishedBy: "o", createdAtMs: 1 }]);
    const idx = mapIndexToGems({ items: { "@o/k": { latest: "9.9.9" } } } as unknown as RegistryIndex);
    const merged = mergeGems(db, idx);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ key: "@o/k", version: "1.0.0", installable: false });
  });

  it("safeDbGems maps rows on success", async () => {
    const gems = await safeDbGems(async () => [
      { gemKey: "@o/k", version: "1.0.0", publishedBy: "o", description: "d", createdAtMs: 1 },
    ]);
    expect(gems).toHaveLength(1);
    expect(gems[0]).toMatchObject({ key: "@o/k", version: "1.0.0", installable: false });
  });

  it("safeDbGems returns [] when the read throws (never-500 contract)", async () => {
    const gems = await safeDbGems(async () => {
      throw new Error("db unavailable");
    });
    expect(gems).toEqual([]);
  });
});
