// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, upsertCatalogGem, gemAccessInfo, listCatalogGemsForOwner } from "@agentgem/aggregator";

const mkAccount = async (db: Awaited<ReturnType<typeof makeTestDb>>, login: string, pid: string) => {
  const id = crypto.randomUUID();
  await db.execute(sql`insert into accounts (id, provider, provider_account_id, login)
                       values (${id}, 'github', ${pid}, ${login})`);
  return id;
};

describe("gemAccessInfo", () => {
  it("returns visibility + owner for a known (key, version)", async () => {
    const db = await makeTestDb();
    const acct1 = await mkAccount(db, "me", "1");
    await upsertCatalogGem(db, { gemKey: "@me/g", version: "0.1.0", publishedBy: "me", createdAtMs: 1, ownerAccountId: acct1, visibility: "private" });
    expect(await gemAccessInfo(db, "@me/g", "0.1.0")).toEqual({ visibility: "private", ownerAccountId: acct1 });
  });
  it("returns null when no catalog row exists (archive-only / unknown)", async () => {
    const db = await makeTestDb();
    expect(await gemAccessInfo(db, "sharedid", "1")).toBeNull();
  });
});

describe("listCatalogGemsForOwner", () => {
  it("returns all of the owner's gems (every visibility), newest first, excludes others", async () => {
    const db = await makeTestDb();
    const acct1 = await mkAccount(db, "me", "1");
    const acct2 = await mkAccount(db, "you", "2");
    await upsertCatalogGem(db, { gemKey: "@me/pub", version: "0.1.0", publishedBy: "me", createdAtMs: 1, ownerAccountId: acct1, visibility: "public" });
    await upsertCatalogGem(db, { gemKey: "@me/prv", version: "0.1.0", publishedBy: "me", createdAtMs: 3, ownerAccountId: acct1, visibility: "private" });
    await upsertCatalogGem(db, { gemKey: "@you/x", version: "0.1.0", publishedBy: "you", createdAtMs: 2, ownerAccountId: acct2, visibility: "public" });
    const mine = await listCatalogGemsForOwner(db, acct1);
    expect(mine.map((g) => [g.gemKey, g.visibility])).toEqual([["@me/prv", "private"], ["@me/pub", "public"]]);
  });
});
