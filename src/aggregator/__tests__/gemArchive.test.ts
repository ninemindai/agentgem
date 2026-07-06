// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { makeTestDb, upsertGemArchive, getGemArchive, upsertCatalogGem, listCatalogGems } from "@agentgem/aggregator";

describe("gem archive store", () => {
  it("round-trips archive bytes and marks the catalog row installable", async () => {
    const db = await makeTestDb();
    await upsertCatalogGem(db, { gemKey: "@me/x", version: "1.0.0", publishedBy: "me", createdAtMs: 1, artifacts: [{ name: "brainstorm", type: "skill" }] });
    // no archive yet → not installable
    expect((await listCatalogGems(db))[0]).toMatchObject({ gemKey: "@me/x", installable: false, artifacts: [{ name: "brainstorm", type: "skill" }] });
    await upsertGemArchive(db, { gemKey: "@me/x", version: "1.0.0", bytes: new Uint8Array([1, 2, 3]), digest: "sha256:abc", createdAtMs: 2 });
    const got = await getGemArchive(db, "@me/x", "1.0.0");
    expect(got && Array.from(got.bytes)).toEqual([1, 2, 3]);
    expect((await listCatalogGems(db))[0].installable).toBe(true);
  });
  it("returns null for a missing archive", async () => {
    const db = await makeTestDb();
    expect(await getGemArchive(db, "@me/none", "1.0.0")).toBeNull();
  });
});
