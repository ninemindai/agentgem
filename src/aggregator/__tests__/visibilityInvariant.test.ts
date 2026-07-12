// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The visibility invariant, in one place: EVERY anonymous (PUBLIC_READ_PATHS) reader that LISTS
// catalog_gems must exclude private/unlisted gems — or it leaks a private gem's key/version/
// description to the world. This near-shipped once (buildProfile + buildOrgCatalog omitted the
// filter). All three list readers now route their WHERE through `visiblePublic()`; this test guards
// them together with one seed. If you add a FOURTH anonymous catalog list reader, use
// `visiblePublic()` and add it here.
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { makeTestDb, listCatalogGems, buildProfile, buildOrgCatalog, upsertCatalogGem, accounts, accountScopes } from "@agentgem/aggregator";

describe("visibility invariant: no anonymous list reader surfaces private/unlisted", () => {
  it("listCatalogGems, buildProfile, and buildOrgCatalog all return ONLY the public gem", async () => {
    const db = await makeTestDb();
    // One owner who has a handle ("octocat") AND owns the scope ("octocat"), publishing @octocat/*.
    const id = randomUUID();
    await db.insert(accounts).values({ id, provider: "github", providerAccountId: id, login: "octocat" });
    await db.execute(sql`insert into "user" (id, email, email_verified, handle) values (${id}, ${id + "@e.com"}, false, ${"octocat"})`);
    await db.insert(accountScopes).values({ accountId: id, scope: "octocat" });

    await upsertCatalogGem(db, { gemKey: "@octocat/pub", version: "1.0.0", publishedBy: "octocat", createdAtMs: 1, ownerAccountId: id, visibility: "public" });
    await upsertCatalogGem(db, { gemKey: "@octocat/prv", version: "1.0.0", publishedBy: "octocat", createdAtMs: 2, ownerAccountId: id, visibility: "private" });
    await upsertCatalogGem(db, { gemKey: "@octocat/unl", version: "1.0.0", publishedBy: "octocat", createdAtMs: 3, ownerAccountId: id, visibility: "unlisted" });

    expect((await listCatalogGems(db)).map((g) => g.gemKey)).toEqual(["@octocat/pub"]);

    const profile = await buildProfile(db, "octocat");
    expect(profile!.gems.map((g) => g.key)).toEqual(["@octocat/pub"]);

    const org = await buildOrgCatalog(db, "octocat");
    expect(org!.gems.map((g) => g.key)).toEqual(["@octocat/pub"]);
    expect(org!.gemCount).toBe(1);
  });
});
