// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, upsertCatalogGem, catalogGemForOwner } from "@agentgem/aggregator";

const mkAccount = async (db: Awaited<ReturnType<typeof makeTestDb>>, login: string, pid: string) => {
  const id = crypto.randomUUID();
  await db.execute(sql`insert into accounts (id, provider, provider_account_id, login) values (${id}, 'github', ${pid}, ${login})`);
  return id;
};

describe("catalogGemForOwner", () => {
  it("returns the owner's private gem (latest version), with visibility populated", async () => {
    const db = await makeTestDb();
    const owner = await mkAccount(db, "me", "pid-1");
    await upsertCatalogGem(db, { gemKey: "@me/g", version: "0.1.0", publishedBy: "me", createdAtMs: 1, ownerAccountId: owner, visibility: "private" });
    await upsertCatalogGem(db, { gemKey: "@me/g", version: "0.2.0", publishedBy: "me", createdAtMs: 2, ownerAccountId: owner, visibility: "private" });
    const g = await catalogGemForOwner(db, "@me/g", owner);
    expect(g).toMatchObject({ gemKey: "@me/g", version: "0.2.0", visibility: "private", ownerAccountId: owner });
  });
  it("returns null when the account does not own the key", async () => {
    const db = await makeTestDb();
    const owner1 = await mkAccount(db, "me", "pid-1");
    const owner2 = await mkAccount(db, "other", "pid-2");
    await upsertCatalogGem(db, { gemKey: "@me/g", version: "0.1.0", publishedBy: "me", createdAtMs: 1, ownerAccountId: owner1, visibility: "private" });
    expect(await catalogGemForOwner(db, "@me/g", owner2)).toBeNull();
    expect(await catalogGemForOwner(db, "@me/none", owner1)).toBeNull();
  });
});
