// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, upsertAccount, toggleStar, migrateAccountsToBetterAuth } from "@agentgem/aggregator";

describe("migrateAccountsToBetterAuth", () => {
  it("backfills user+account for an existing accounts row, is idempotent, and preserves FKs", async () => {
    const db = await makeTestDb();
    const acct = await upsertAccount(db, { provider: "github", accountId: "12345", login: "neo", avatarUrl: "https://example.com/neo.png" });
    await toggleStar(db, acct.id, "gem", "some-gem");

    const first = await migrateAccountsToBetterAuth(db);
    expect(first.conflicts).toEqual([]);
    expect(first.migrated).toBe(1);

    const second = await migrateAccountsToBetterAuth(db);
    expect(second.conflicts).toEqual([]);
    expect(second.migrated).toBe(0);

    const userRows = (await db.execute(sql`select id, login from "user" where id = ${acct.id}`)).rows as { id: string; login: string }[];
    expect(userRows).toHaveLength(1);
    expect(userRows[0].login).toBe("neo");

    const accountRows = (await db.execute(
      sql`select user_id, provider_id, account_id from "account" where provider_id = 'github' and account_id = '12345'`,
    )).rows as { user_id: string; provider_id: string; account_id: string }[];
    expect(accountRows).toHaveLength(1);
    expect(accountRows[0].user_id).toBe(acct.id);

    // the legacy FK still resolves through the shared id.
    const starRows = (await db.execute(sql`select account_id from stars where account_id = ${acct.id}`)).rows as { account_id: string }[];
    expect(starRows).toHaveLength(1);
  });

  it("reports a conflict instead of silently accepting a mismatched (provider, account_id) link", async () => {
    const db = await makeTestDb();
    const acct = await upsertAccount(db, { provider: "github", accountId: "999", login: "trinity", avatarUrl: null });

    // Pre-seed a DIFFERENT user + an "account" row for the same github id pointing at that other user.
    await db.execute(sql`insert into "user" (id, name, email_verified, image, login, created_at, updated_at)
      values ('other-user-id', 'Other', false, null, 'other', now(), now())`);
    await db.execute(sql`insert into "account" (id, user_id, provider_id, account_id, created_at, updated_at)
      values ('acc-1', 'other-user-id', 'github', '999', now(), now())`);

    const result = await migrateAccountsToBetterAuth(db);

    expect(result.conflicts).toEqual(["999"]);

    // the mismatched link must NOT have been silently overwritten.
    const accountRows = (await db.execute(
      sql`select user_id from "account" where provider_id = 'github' and account_id = '999'`,
    )).rows as { user_id: string }[];
    expect(accountRows).toHaveLength(1);
    expect(accountRows[0].user_id).toBe("other-user-id");
    expect(accountRows[0].user_id).not.toBe(acct.id);
  });
});
