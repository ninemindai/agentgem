// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// One-time idempotent backfill (Plan 1a Task 5): give every EXISTING accounts row a same-id
// better-auth "user" + "account", so the legacy uuid FKs (stars/reviews/usage/scopes/groups ->
// accounts.id) stay valid after cutover. Additive; a pure data-migration, no behavior change.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { AppDb } from "../schema.js";
import type { Account } from "../webAuth.js";

// Single-row counterpart to migrateAccountsToBetterAuth (Plan 1b device-flow bind): the same
// insert-if-absent "user"/"account" anchor, scoped to one already-reconciled `accounts` row,
// so a session can be minted for it immediately without waiting for the next boot backfill.
// Raw SQL against the tables directly (not better-auth's adapter/API), so it never fires the
// databaseHooks anchorAndScopes hook (betterAuth.ts) — idempotent via on-conflict-do-nothing.
export async function ensureBetterAuthUser(db: AppDb, account: Account): Promise<void> {
  await db.execute(sql`insert into "user" (id, name, email_verified, image, login, created_at, updated_at)
    values (${account.id}, ${account.login}, false, ${account.avatarUrl}, ${account.login}, now(), now()) on conflict (id) do nothing`);
  await db.execute(sql`insert into "account" (id, user_id, provider_id, account_id, created_at, updated_at)
    values (${randomUUID()}, ${account.id}, ${account.provider}, ${account.providerAccountId}, now(), now()) on conflict (provider_id, account_id) do nothing`);
}

// Re-run at cutover (Plan 1b-Task 5), so the whole check-then-insert runs in ONE transaction: without
// it, a concurrent legacy-OAuth signup between the conflict SELECT and the "account" INSERT below
// could slip in a mismatched (provider_id, account_id) link that the conflict check never saw
// (a TOCTOU window) — the transaction closes that by serializing the check and the writes together.
export async function migrateAccountsToBetterAuth(db: AppDb): Promise<{ migrated: number; conflicts: string[] }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`insert into "user" (id, name, email_verified, image, login, created_at, updated_at)
      select a.id::text, a.login, false, a.avatar_url, a.login, now(), now() from accounts a on conflict (id) do nothing`);
    // conflict check BEFORE inserting accounts
    const bad = (await tx.execute(sql`select ac.account_id from "account" ac join accounts a
      on ac.provider_id = a.provider and ac.account_id = a.provider_account_id where ac.user_id <> a.id::text`)).rows as { account_id: string }[];
    const res = await tx.execute(sql`insert into "account" (id, user_id, provider_id, account_id, created_at, updated_at)
      select gen_random_uuid()::text, a.id::text, a.provider, a.provider_account_id, now(), now() from accounts a on conflict (provider_id, account_id) do nothing`);
    // node-postgres (production) reports rowCount; pglite (dev/test) reports affectedRows.
    const migrated = (res as any).rowCount ?? (res as any).affectedRows ?? 0;
    return { migrated, conflicts: bad.map((b) => b.account_id) };
  });
}
