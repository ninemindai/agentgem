// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { makeTestDb, catalogGems } from "@agentgem/aggregator";
import { AggregatorController } from "../../aggregator.controller.js";

describe("AggregatorController.orgCatalog", () => {
  it("returns the catalog for a valid scope", async () => {
    const db = await makeTestDb();
    await db.insert(catalogGems).values({ gemKey: "@acme/a", version: "1.0.0", publishedBy: "dev", description: "d", tags: ["x"], artifactKinds: ["skill"], type: "skill", grade: 2, createdAtMs: 1 });
    const ctl = new AggregatorController(db as never);
    const r = await ctl.orgCatalog({ query: { scope: "acme" } });
    expect(r.scope).toBe("acme");
    expect(r.gemCount).toBe(1);
    expect(r.gems[0].key).toBe("@acme/a");
  });

  it("returns an empty catalog for an unknown scope", async () => {
    const db = await makeTestDb();
    const ctl = new AggregatorController(db as never);
    const r = await ctl.orgCatalog({ query: { scope: "nobody" } });
    expect(r).toEqual({ scope: "nobody", gemCount: 0, ownerCount: 0, gems: [] });
  });

  it("throws for a malformed scope", async () => {
    const db = await makeTestDb();
    const ctl = new AggregatorController(db as never);
    await expect(ctl.orgCatalog({ query: { scope: "bad/scope" } })).rejects.toThrow(/scope/i);
  });
});
