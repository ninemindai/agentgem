// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Existence-leak regression: GET /api/aggregator/profile is anonymous and PUBLIC_READ_PATHS-listed
// (see @agentback originGuard), so buildProfile must never surface a private/unlisted gem's
// key/version/description to an unauthenticated caller — mirrors listCatalogGems's visibility filter.
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { makeTestDb, buildProfile, upsertCatalogGem, accounts } from "@agentgem/aggregator";

async function ghUser(db: Awaited<ReturnType<typeof makeTestDb>>, login: string, handle: string) {
  const id = randomUUID();
  await db.insert(accounts).values({ id, provider: "github", providerAccountId: id, login });
  await db.execute(sql`insert into "user" (id, email, email_verified, handle) values (${id}, ${id + "@e.com"}, false, ${handle})`);
  return id;
}

describe("buildProfile visibility filter (existence leak)", () => {
  it("excludes a private gem and an unlisted gem, keeps the public one, for the SAME owner", async () => {
    const db = await makeTestDb();
    const id = await ghUser(db, "octocat", "octocat");
    await upsertCatalogGem(db, { gemKey: "@octocat/pub", version: "1.0.0", publishedBy: "octocat", createdAtMs: 1, ownerAccountId: id, visibility: "public" });
    await upsertCatalogGem(db, { gemKey: "@octocat/prv", version: "1.0.0", publishedBy: "octocat", createdAtMs: 2, ownerAccountId: id, visibility: "private" });
    await upsertCatalogGem(db, { gemKey: "@octocat/unl", version: "1.0.0", publishedBy: "octocat", createdAtMs: 3, ownerAccountId: id, visibility: "unlisted" });

    const p = await buildProfile(db, "octocat");
    expect(p).not.toBeNull();
    expect(p!.gems.map((g) => g.key)).toEqual(["@octocat/pub"]);
  });
});
