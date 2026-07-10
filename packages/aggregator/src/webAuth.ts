// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Web account store. `webSessions` (the legacy sha256-hashed session table) is dead — better-auth's
// own `session` table is authoritative post-cutover (Plan 1b-Task 5) — but `accounts` and the scope/
// handoff helpers below stay live: every legacy FK (stars/reviews/usage/scopes/groups) still points
// at `accounts.id`, which better-auth's migration preserves as `user.id`.
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import type { Auth, BetterAuthOptions } from "better-auth";
import type { AppDb } from "./schema.js";
import { accounts, accountScopes, handoffCodes } from "./schema.js";

const sha256hex = (s: string): string => createHash("sha256").update(s).digest("hex");

export interface Account { id: string; provider: string; providerAccountId: string; login: string | null; avatarUrl: string | null }

export async function upsertAccount(
  db: AppDb,
  a: { provider: string; accountId: string; login: string | null; avatarUrl?: string | null; id?: string },
): Promise<Account> {
  const id = a.id ?? randomUUID();
  const rows = await db
    .insert(accounts)
    .values({ id, provider: a.provider, providerAccountId: a.accountId, login: a.login, avatarUrl: a.avatarUrl ?? null })
    .onConflictDoUpdate({
      target: [accounts.provider, accounts.providerAccountId],
      set: { login: a.login, avatarUrl: a.avatarUrl ?? null },
    })
    .returning({ id: accounts.id, provider: accounts.provider, providerAccountId: accounts.providerAccountId, login: accounts.login, avatarUrl: accounts.avatarUrl });
  return rows[0];
}

/** Look up the legacy `accounts` anchor row by id — the SSO handoff redeem's only handle on the
 *  bound account is the uuid `redeemHandoffCode` returns, so it needs this to rebuild the `Account`
 *  shape `ensureBetterAuthUser` requires. */
export async function getAccountById(db: AppDb, id: string): Promise<Account | null> {
  const rows = await db
    .select({ id: accounts.id, provider: accounts.provider, providerAccountId: accounts.providerAccountId, login: accounts.login, avatarUrl: accounts.avatarUrl })
    .from(accounts)
    .where(eq(accounts.id, id))
    .limit(1);
  return rows[0] ?? null;
}

// Plan 1b cutover (review fix 3A): better-auth is now authoritative for session resolution. It reads
// its OWN cookie (name/signing are its concern, not ours) or an `Authorization: Bearer` header off
// the headers we forward — callers must NOT pre-extract a token by cookie NAME (that was the bug:
// better-auth's cookie isn't named `ag_session`, so guessing the name 401s every web request).
// Generic over the options type so any makeAuth(...)-produced Auth<O> is accepted here — Auth<O> is
// invariant in O, so a non-generic `Auth<BetterAuthOptions>` parameter would reject it (mirrors mintSession).
// `auth.api`'s type is derived from O's plugin list, which TS cannot fully resolve for a generic O
// (the core `getSession` endpoint drops out of `InferAPI<...>` when O isn't a concrete object type).
// This structural view is exactly what every concrete makeAuth(...) instance's `auth.api.getSession`
// already satisfies (proven by betterAuthIntegration.test.ts) — the cast below only works around the
// generic-inference gap, it does not change what's actually called at runtime.
type SessionApi = {
  getSession(opts: { headers: Headers }): Promise<{ user?: { id: string; login?: string; image?: string | null } } | null>;
};

export async function resolveSession<O extends BetterAuthOptions>(
  auth: Auth<O>,
  headers: Record<string, string | undefined> | Headers,
): Promise<{ login: string; avatarUrl: string | null; accountId: string } | null> {
  const h = headers instanceof Headers
    ? headers
    : Object.entries(headers).reduce((acc, [k, v]) => { if (typeof v === "string") acc.set(k, v); return acc; }, new Headers());
  const res = await (auth.api as unknown as SessionApi).getSession({ headers: h });
  const u = res?.user;
  return u ? { login: u.login ?? "", avatarUrl: u.image ?? null, accountId: u.id } : null;
}

/** Mint a single-use SSO handoff code bound to an account. Only sha256(code) is stored. */
export async function createHandoffCode(db: AppDb, accountId: string, ttlMs: number): Promise<{ code: string; expiresAt: string }> {
  const code = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlMs);
  await db.insert(handoffCodes).values({ codeHash: sha256hex(code), accountId, expiresAt });
  return { code, expiresAt: expiresAt.toISOString() };
}

/** Redeem a handoff code: delete-on-read (single use) and return its accountId iff unexpired.
 *  Opportunistically sweeps expired codes so the table can't grow unbounded. */
export async function redeemHandoffCode(db: AppDb, code: string, now: number = Date.now()): Promise<string | null> {
  const rows = await db
    .delete(handoffCodes)
    .where(eq(handoffCodes.codeHash, sha256hex(code)))
    .returning({ accountId: handoffCodes.accountId, expiresAt: handoffCodes.expiresAt });
  await db.delete(handoffCodes).where(lt(handoffCodes.expiresAt, new Date(now)));
  const row = rows[0];
  if (!row || new Date(row.expiresAt).getTime() <= now) return null;
  return row.accountId;
}

/** A scope grant: bare string = role "member" (an org the account belongs to); pass an object to
 *  carry GitHub's org role ("admin").
 *
 *  There is deliberately NO "self" role. The account's own namespace is its `"user".handle`, read
 *  directly by `accountSelfScope`/`accountOwnsScope` — never mirrored into a row here. Widening
 *  this union back to include "self" would re-admit the three-writer drift the re-key removed
 *  (see the doc comment on `accountSelfScope` in handles.ts), so the type is the guard: a `self`
 *  write is a compile error, not a code-review catch. */
export type ScopeGrant = string | { scope: string; role: "admin" | "member" };

/** REPLACE the account's captured ORG memberships. Deduped (first grant wins); empty clears them.
 *  Rows get a fresh captured_at, which freshness-gated reads rely on. Never carries the account's
 *  own handle — see ScopeGrant. */
export async function setAccountScopes(db: AppDb, accountId: string, scopes: ScopeGrant[]): Promise<void> {
  const byScope = new Map<string, { scope: string; role: string }>();
  for (const g of scopes) {
    const entry = typeof g === "string" ? { scope: g, role: "member" } : g;
    if (!byScope.has(entry.scope)) byScope.set(entry.scope, entry);
  }
  await db.delete(accountScopes).where(eq(accountScopes.accountId, accountId));
  if (byScope.size > 0) {
    await db.insert(accountScopes).values([...byScope.values()].map((e) => ({ accountId, scope: e.scope, role: e.role })));
  }
}

/** All scopes the account owns, with role + capture time — the authed "my orgs" listing. */
export async function getAccountScopes(db: AppDb, accountId: string): Promise<{ scope: string; role: string; capturedAt: Date }[]> {
  return db
    .select({ scope: accountScopes.scope, role: accountScopes.role, capturedAt: accountScopes.capturedAt })
    .from(accountScopes)
    .where(eq(accountScopes.accountId, accountId));
}

/** True iff the account owns `scope`: it is either the account's own handle, or an org membership
 *  captured at sign-in/bind. Two sources because they are two different facts — the handle IS the
 *  account (source of truth, `"user".handle`), while an org grant is a captured claim about GitHub.
 *
 *  The org half excludes any legacy `role='self'` row. Such rows are stale mirrors of the handle
 *  written by the pre-re-key code; honoring one would let a renamed-away name keep granting publish
 *  (see `accountSelfScope` in handles.ts). `ensureSchema` deletes them, and this filter is what
 *  makes that cleanup non-load-bearing.
 *
 *  Case-insensitive on the name (GitHub logins/handles are), exact on `account_id` — this only
 *  changes which row matches, never who counts as the account. */
export async function accountOwnsScope(db: AppDb, accountId: string, scope: string): Promise<boolean> {
  const r = await db.execute(sql`
    select 1 where
         exists (select 1 from "user"
                  where id = ${accountId} and handle is not null and lower(handle) = lower(${scope}))
      or exists (select 1 from account_scopes
                  where account_id = ${accountId} and lower(scope) = lower(${scope})
                    and role in ('admin','member'))`);
  return (r.rows?.length ?? 0) > 0;
}

export type ScopeStatus = "ok" | "stale" | "none";

/** Ownership + freshness + role in ONE lookup — the captured-ORG-membership gate primitive. Scopes
 *  are only re-captured from GitHub at sign-in/bind, so a grant older than `maxAgeMs` is "stale":
 *  the caller still matched, but should be asked to refresh (re-auth) rather than served. `role` is
 *  the grant's captured GitHub role ("admin" | "member"), null when no grant exists.
 *
 *  Case-insensitive on the scope name, matching `accountScopeRole` byte-for-byte so the two always
 *  agree on which row they are reading. (They were both exact-match before, which silently 403'd a
 *  legitimate member of an App-less org whose URL casing differed from GitHub's canonical casing —
 *  e.g. `/orgs/ninemindai` against a stored `NineMindAI`.)
 *
 *  Excludes legacy `role='self'` rows: the self grant is derived from `"user".handle`, never stored.
 *  Honoring a stale mirror here would let it survive an org's later App installation. */
export async function accountScopeInfo(
  db: AppDb, accountId: string, scope: string, maxAgeMs: number, now: number = Date.now(),
): Promise<{ status: ScopeStatus; role: string | null }> {
  const rows = await db
    .select({ capturedAt: accountScopes.capturedAt, role: accountScopes.role })
    .from(accountScopes)
    .where(and(
      eq(accountScopes.accountId, accountId),
      sql`lower(${accountScopes.scope}) = lower(${scope})`,
      sql`${accountScopes.role} in ('admin','member')`,
    ))
    .limit(1);
  if (rows.length === 0) return { status: "none", role: null };
  const fresh = now - new Date(rows[0].capturedAt).getTime() <= maxAgeMs;
  return { status: fresh ? "ok" : "stale", role: rows[0].role };
}

/** Freshness-only view of accountScopeInfo (kept for existing callers). */
export async function accountScopeStatus(
  db: AppDb, accountId: string, scope: string, maxAgeMs: number, now: number = Date.now(),
): Promise<ScopeStatus> {
  return (await accountScopeInfo(db, accountId, scope, maxAgeMs, now)).status;
}
