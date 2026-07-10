// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The handle is the ONLY human-readable name for an account. It authorizes nothing — every
// ownership and access check keys on accounts.id (a uuid) — so it may be NULL until claimed.
import { sql } from "drizzle-orm";
import type { AppDb } from "./schema.js";
import { setAccountScopes, getAccountScopes } from "./webAuth.js";

const HANDLE_RE = /^[A-Za-z0-9-]{1,39}$/;

export type ClaimResult = { ok: true; handle: string } | { ok: false; reason: "charset" | "unavailable" };

/** Handles and GitHub org scopes share ONE namespace, and accountOwnsScope ignores the scope's
 *  role — so claiming an org's name would grant a role='self' row and with it the right to publish
 *  under that org. This is the only place that guard lives. org_members.org_scope and
 *  org_settings.scope are two different column names for the same namespace. */
async function isReserved(db: AppDb, handleLc: string): Promise<boolean> {
  const r = await db.execute(sql`
    select 1 from org_members  where lower(org_scope) = ${handleLc}
    union all
    select 1 from org_settings where lower(scope)      = ${handleLc}
    limit 1`);
  return (r.rows?.length ?? 0) > 0;
}

export async function accountIdForHandle(db: AppDb, handle: string): Promise<string | null> {
  if (!HANDLE_RE.test(handle)) return null;
  const r = await db.execute(sql`select id from "user" where lower(handle) = lower(${handle}) limit 1`);
  return (r.rows as { id: string }[])[0]?.id ?? null;
}

export async function handleForAccountId(db: AppDb, accountId: string): Promise<string | null> {
  const r = await db.execute(sql`select handle from "user" where id = ${accountId} limit 1`);
  return (r.rows as { handle: string | null }[])[0]?.handle ?? null;
}

/** Claim or rename. "taken" and "reserved" collapse into one `unavailable` result on purpose:
 *  distinguishing them would let a prober enumerate the GitHub orgs the App has seen.
 *  The UNIQUE index — not a prior SELECT — arbitrates a race between two concurrent claims. */
export async function claimHandle(db: AppDb, accountId: string, raw: string): Promise<ClaimResult> {
  const handle = raw.trim();
  if (!HANDLE_RE.test(handle)) return { ok: false, reason: "charset" };
  if (await isReserved(db, handle.toLowerCase())) return { ok: false, reason: "unavailable" };

  const prior = await handleForAccountId(db, accountId);
  try {
    const r = await db.execute(sql`
      update "user" set handle = ${handle}
      where id = ${accountId}
        and not exists (select 1 from "user" u2 where lower(u2.handle) = lower(${handle}) and u2.id <> ${accountId})
      returning id`);
    if ((r.rows?.length ?? 0) === 0) return { ok: false, reason: "unavailable" };
  } catch {
    return { ok: false, reason: "unavailable" };   // unique index lost the race
  }

  // Replace the role='self' scope with the new handle, dropping the stale one. Org memberships
  // (role 'admin'/'member') are preserved: a rename must not revoke them.
  const kept = (await getAccountScopes(db, accountId))
    .filter((s) => s.role !== "self" && s.scope.toLowerCase() !== (prior ?? "").toLowerCase())
    .map((s) => ({ scope: s.scope, role: s.role as "admin" | "member" }));
  await setAccountScopes(db, accountId, [{ scope: handle, role: "self" as const }, ...kept]);
  return { ok: true, handle };
}
