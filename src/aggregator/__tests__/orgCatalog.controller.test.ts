// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { makeTestDb, catalogGems, accounts } from "@agentgem/aggregator";
import { AggregatorController } from "../../aggregator.controller.js";

describe("AggregatorController.orgCatalog", () => {
  it("returns the catalog for a valid scope", async () => {
    const db = await makeTestDb();
    // Self-scope, identity re-key style (task 7): the OWNER is the account whose claimed handle IS
    // the scope ("acme"), resolved via accountIdForHandle — not a published_by string match.
    const id = randomUUID();
    await db.insert(accounts).values({ id, provider: "github", providerAccountId: id, login: "acme" });
    await db.execute(sql`insert into "user" (id, email, email_verified, handle) values (${id}, ${id + "@e.com"}, false, 'acme')`);
    await db.insert(catalogGems).values({ gemKey: "@acme/a", version: "1.0.0", publishedBy: "acme", description: "d", tags: ["x"], artifactKinds: ["skill"], type: "skill", grade: 2, createdAtMs: 1, ownerAccountId: id });
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
