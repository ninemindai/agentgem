// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, upsertAccount } from "@agentgem/aggregator";
import { migrateAccountsOrFail } from "../index.js";

describe("migrateAccountsOrFail (boot-time cutover backfill, Plan 1b-Task 5)", () => {
  it("returns migrated count when the backfill is conflict-clean", async () => {
    const db = await makeTestDb();
    await upsertAccount(db, { provider: "github", accountId: "12345", login: "neo", avatarUrl: null });
    await expect(migrateAccountsOrFail(db)).resolves.toEqual({ migrated: 1 });
  });

  it("throws (fails startup) when the backfill reports an account link conflict", async () => {
    const db = await makeTestDb();
    await upsertAccount(db, { provider: "github", accountId: "999", login: "trinity", avatarUrl: null });
    // Pre-seed a DIFFERENT user + an "account" row for the same github id pointing at that other
    // user — the same mismatched-link setup migrateAccounts.test.ts uses to prove the conflict is
    // detected; here we prove it's fatal at boot, not just reported.
    await db.execute(sql`insert into "user" (id, name, email_verified, image, login, created_at, updated_at)
      values ('other-user-id', 'Other', false, null, 'other', now(), now())`);
    await db.execute(sql`insert into "account" (id, user_id, provider_id, account_id, created_at, updated_at)
      values ('acc-1', 'other-user-id', 'github', '999', now(), now())`);

    await expect(migrateAccountsOrFail(db)).rejects.toThrow(/account link conflict/);
  });
});
