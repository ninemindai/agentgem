// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { backfillGemOwners } from "@agentgem/aggregator";
import { makeTestDb } from "@agentgem/aggregator";

const acct = (login: string | null, pid: string) =>
  sql`insert into accounts (id, provider, provider_account_id, login)
      values (gen_random_uuid(), 'github', ${pid}, ${login}) returning id`;
const gem = (key: string, by: string) =>
  sql`insert into catalog_gems (gem_key, version, published_by, created_at_ms)
      values (${key}, '1.0.0', ${by}, 1)`;
const ownerOf = async (db: Awaited<ReturnType<typeof makeTestDb>>, key: string) =>
  ((await db.execute(sql`select owner_account_id from catalog_gems where gem_key = ${key}`))
    .rows as { owner_account_id: string | null }[])[0].owner_account_id;

describe("backfillGemOwners", () => {
  it("resolves a gem to its sole matching account, case-insensitively", async () => {
    const db = await makeTestDb();
    const id = ((await db.execute(acct("Raymond", "1"))).rows as { id: string }[])[0].id;
    await db.execute(gem("@r/a", "raymond"));
    const r = await backfillGemOwners(db);
    expect(r).toEqual({ resolved: 1, unresolved: 0 });
    expect(await ownerOf(db, "@r/a")).toBe(id);
  });

  it("leaves BOTH gems unresolved when two accounts share a login", async () => {
    const db = await makeTestDb();
    await db.execute(acct("dup", "1"));
    await db.execute(acct("DUP", "2"));       // no unique constraint on accounts.login
    await db.execute(gem("@d/a", "dup"));
    await db.execute(gem("@d/b", "DUP"));
    const r = await backfillGemOwners(db);
    expect(r).toEqual({ resolved: 0, unresolved: 2 });
    expect(await ownerOf(db, "@d/a")).toBeNull();
    expect(await ownerOf(db, "@d/b")).toBeNull();
  });

  it("leaves a gem unresolved when no account matches, and is idempotent", async () => {
    const db = await makeTestDb();
    await db.execute(gem("@ghost/a", "deleted-user"));
    expect(await backfillGemOwners(db)).toEqual({ resolved: 0, unresolved: 1 });
    expect(await backfillGemOwners(db)).toEqual({ resolved: 0, unresolved: 1 });
    expect(await ownerOf(db, "@ghost/a")).toBeNull();
  });

  it("never re-assigns a row that already has an owner", async () => {
    const db = await makeTestDb();
    const a = ((await db.execute(acct("keep", "1"))).rows as { id: string }[])[0].id;
    await db.execute(acct("other", "2"));
    await db.execute(gem("@k/a", "other"));
    await db.execute(sql`update catalog_gems set owner_account_id = ${a} where gem_key = '@k/a'`);
    await backfillGemOwners(db);
    expect(await ownerOf(db, "@k/a")).toBe(a);   // not reassigned to 'other'
  });
});
