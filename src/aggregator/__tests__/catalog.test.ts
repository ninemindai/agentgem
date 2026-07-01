// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { makeTestDb, upsertCatalogGem, listCatalogGems } from "@agentgem/aggregator";

describe("catalog store", () => {
  it("inserts and lists a catalog gem", async () => {
    const db = await makeTestDb();
    await upsertCatalogGem(db, { gemKey: "@octocat/kit", version: "1.0.0", publishedBy: "octocat", description: "d", tags: ["x"], artifactKinds: ["skill"], grade: 2, createdAtMs: 1000 });
    const rows = await listCatalogGems(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ gemKey: "@octocat/kit", version: "1.0.0", publishedBy: "octocat", grade: 2, tags: ["x"] });
  });

  it("upserts on (gemKey, version) — no duplicate rows", async () => {
    const db = await makeTestDb();
    await upsertCatalogGem(db, { gemKey: "@o/k", version: "1.0.0", publishedBy: "o", description: "first", createdAtMs: 1 });
    await upsertCatalogGem(db, { gemKey: "@o/k", version: "1.0.0", publishedBy: "o", description: "second", createdAtMs: 2 });
    const rows = await listCatalogGems(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toBe("second");
  });
});
