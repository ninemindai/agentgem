// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Existence-leak regression: GET /api/aggregator/org-catalog is anonymous and PUBLIC_READ_PATHS-listed
// (see @agentback originGuard), so buildOrgCatalog must never surface a private/unlisted gem's
// key/version/description to an unauthenticated caller — mirrors listCatalogGems's visibility filter.
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb, buildOrgCatalog, upsertCatalogGem, accounts, accountScopes } from "@agentgem/aggregator";

async function own(db: Awaited<ReturnType<typeof makeTestDb>>, login: string, scope: string) {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, provider: "github", providerAccountId: "o" + accountId, login });
  await db.insert(accountScopes).values({ accountId, scope });
  return accountId;
}

describe("buildOrgCatalog visibility filter (existence leak)", () => {
  it("excludes a private gem and an unlisted gem, keeps the public one, for the SAME scope owner", async () => {
    const db = await makeTestDb();
    const dev = await own(db, "dev1", "acme");
    await upsertCatalogGem(db, { gemKey: "@acme/pub", version: "1.0.0", publishedBy: "dev1", createdAtMs: 1, ownerAccountId: dev, visibility: "public" });
    await upsertCatalogGem(db, { gemKey: "@acme/prv", version: "1.0.0", publishedBy: "dev1", createdAtMs: 2, ownerAccountId: dev, visibility: "private" });
    await upsertCatalogGem(db, { gemKey: "@acme/unl", version: "1.0.0", publishedBy: "dev1", createdAtMs: 3, ownerAccountId: dev, visibility: "unlisted" });

    const c = await buildOrgCatalog(db, "acme");
    expect(c).not.toBeNull();
    expect(c!.gems.map((g) => g.key)).toEqual(["@acme/pub"]);
    expect(c!.gemCount).toBe(1);
  });
});
