// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// One-time idempotent backfill (Plan 1a Task 5): give every EXISTING accounts row a same-id
// better-auth "user" + "account", so the legacy uuid FKs (stars/reviews/usage/scopes/groups ->
// accounts.id) stay valid after cutover. Additive; a pure data-migration, no behavior change.
import { sql } from "drizzle-orm";
import type { AppDb } from "../schema.js";

export async function migrateAccountsToBetterAuth(db: AppDb): Promise<{ migrated: number; conflicts: string[] }> {
  await db.execute(sql`insert into "user" (id, name, email_verified, image, login, created_at, updated_at)
    select a.id::text, a.login, false, a.avatar_url, a.login, now(), now() from accounts a on conflict (id) do nothing`);
  // conflict check BEFORE inserting accounts
  const bad = (await db.execute(sql`select ac.account_id from "account" ac join accounts a
    on ac.provider_id = a.provider and ac.account_id = a.provider_account_id where ac.user_id <> a.id::text`)).rows as { account_id: string }[];
  const res = await db.execute(sql`insert into "account" (id, user_id, provider_id, account_id, created_at, updated_at)
    select gen_random_uuid()::text, a.id::text, a.provider, a.provider_account_id, now(), now() from accounts a on conflict (provider_id, account_id) do nothing`);
  // node-postgres (production) reports rowCount; pglite (dev/test) reports affectedRows.
  const migrated = (res as any).rowCount ?? (res as any).affectedRows ?? 0;
  return { migrated, conflicts: bad.map((b) => b.account_id) };
}
