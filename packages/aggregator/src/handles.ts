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

/** Postgres SQLSTATE for a unique-constraint violation. Verified directly against both drivers
 *  this repo runs against (see testDb.ts / localDb.ts): PGlite's thrown error and node-postgres'
 *  DatabaseError both surface it as a plain top-level `err.code` string — drizzle's `execute()`
 *  doesn't catch/rewrap around a plain query in either the pglite or node-postgres session
 *  (checked drizzle-orm@0.45.2's session sources: no try/catch around query execution outside of
 *  its transaction-rollback path). A deadlock, a lost connection, or a DIFFERENT constraint has a
 *  different code (or none) and must propagate, not collapse into "handle taken". */
const UNIQUE_VIOLATION = "23505";
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === UNIQUE_VIOLATION;
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

/** The auto-claim half of the identity re-key (Task 5b): give a login-less account's handle for
 *  free on GitHub sign-in, so `backfillUserHandles`' bulk pass and this per-account path are the
 *  only two places besides `claimHandle` that ever write "user".handle. Same guards (charset,
 *  reserved, uniqueness) as `claimHandle`, enforced here directly rather than by calling
 *  `claimHandle` itself — `claimHandle` also REPLACES the account's entire scope set (a rename's
 *  job), and `anchorAndScopes` needs to fold the self-scope into its own single `setAccountScopes`
 *  call alongside org memberships, not clobber them twice.
 *
 *  Only claims when the account's handle IS NULL — an existing (possibly renamed) handle is never
 *  touched, which is what lets a rename survive re-login. Best-effort: returns `null` (not a throw)
 *  on a reserved/taken/malformed name, so a caller can no-op past it. */
export async function claimHandleIfUnset(db: AppDb, accountId: string, raw: string): Promise<string | null> {
  const handle = raw.trim();
  if (!HANDLE_RE.test(handle)) return null;
  if (await isReserved(db, handle.toLowerCase())) return null;
  try {
    const r = await db.execute(sql`
      update "user" set handle = ${handle}
      where id = ${accountId}
        and handle is null
        and not exists (select 1 from "user" u2 where lower(u2.handle) = lower(${handle}) and u2.id <> ${accountId})
      returning id`);
    return (r.rows?.length ?? 0) > 0 ? handle : null;
  } catch (err) {
    if (isUniqueViolation(err)) return null;   // unique index lost the race
    throw err;
  }
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
  } catch (err) {
    // Narrow to the unique index actually losing the race — anything else (a deadlock, a lost
    // connection, an unrelated constraint) is a real failure and must not be reported as a normal
    // "handle taken" domain result.
    if (isUniqueViolation(err)) return { ok: false, reason: "unavailable" };
    throw err;
  }

  // Replace the role='self' scope with the new handle, dropping the stale one. Org memberships
  // (role 'admin'/'member') are preserved: a rename must not revoke them. `prior` is nullable
  // (first-ever claim has no prior handle) — checked explicitly rather than via a `?? ""`
  // fallback, since the whole point of this migration is that an empty string is not an identity.
  const isStalePriorHandleScope = (s: { scope: string }) => prior != null && s.scope.toLowerCase() === prior.toLowerCase();
  const kept = (await getAccountScopes(db, accountId))
    .filter((s) => s.role !== "self" && !isStalePriorHandleScope(s))
    .map((s) => ({ scope: s.scope, role: s.role as "admin" | "member" }));
  await setAccountScopes(db, accountId, [{ scope: handle, role: "self" as const }, ...kept]);
  return { ok: true, handle };
}
