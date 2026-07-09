// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Web account + session store. The session cookie carries an opaque random token; only its
// sha256 hash is persisted, so a DB leak cannot mint sessions.
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import type { Auth, BetterAuthOptions } from "better-auth";
import type { AppDb } from "./schema.js";
import { accounts, webSessions, accountScopes, handoffCodes } from "./schema.js";

const sha256hex = (s: string): string => createHash("sha256").update(s).digest("hex");

export interface Account { id: string; provider: string; providerAccountId: string; login: string; avatarUrl: string | null }

export function generateSessionToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: sha256hex(token) };
}

export async function upsertAccount(
  db: AppDb,
  a: { provider: string; accountId: string; login: string; avatarUrl?: string | null; id?: string },
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

export async function createSession(db: AppDb, accountId: string, token: string, ttlMs: number): Promise<void> {
  await db.insert(webSessions).values({
    id: randomUUID(),
    tokenHash: sha256hex(token),
    accountId,
    expiresAt: new Date(Date.now() + ttlMs),
  });
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

export async function deleteSession(db: AppDb, token: string): Promise<void> {
  await db.delete(webSessions).where(eq(webSessions.tokenHash, sha256hex(token)));
}

// The pre-cutover, `web_sessions`-table-backed lookup — kept ONLY for src/auth/install.ts, the
// legacy OAuth handler Plan 1b-Task 5 deletes outright. Every other consumer has moved to the
// better-auth-backed `resolveSession` above; do not add new callers of this one.
export async function resolveLegacySession(db: AppDb, token: string): Promise<{ login: string; avatarUrl: string | null; accountId: string } | null> {
  const rows = await db
    .select({ login: accounts.login, avatarUrl: accounts.avatarUrl, accountId: accounts.id })
    .from(webSessions)
    .innerJoin(accounts, eq(webSessions.accountId, accounts.id))
    .where(and(eq(webSessions.tokenHash, sha256hex(token)), gt(webSessions.expiresAt, new Date())))
    .limit(1);
  return rows[0] ?? null;
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
 *  carry GitHub's org role ("admin") or "self" for the account's own login scope. */
export type ScopeGrant = string | { scope: string; role: "self" | "admin" | "member" };

/** REPLACE the account's owned scope set (login + org logins). Deduped (first grant wins);
 *  empty clears it. Rows get a fresh captured_at, which freshness-gated reads rely on. */
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

/** True iff the account owns `scope` (its login or a captured org membership). */
export async function accountOwnsScope(db: AppDb, accountId: string, scope: string): Promise<boolean> {
  const rows = await db
    .select({ scope: accountScopes.scope })
    .from(accountScopes)
    .where(and(eq(accountScopes.accountId, accountId), eq(accountScopes.scope, scope)))
    .limit(1);
  return rows.length > 0;
}

export type ScopeStatus = "ok" | "stale" | "none";

/** Ownership + freshness + role in ONE lookup — the membership-gate primitive. Scopes are only
 *  re-captured from GitHub at sign-in/bind, so a grant older than `maxAgeMs` is "stale": the
 *  caller still matched, but should be asked to refresh (re-auth) rather than served. `role` is
 *  the grant's captured GitHub role ("self" | "admin" | "member"), null when no grant exists. */
export async function accountScopeInfo(
  db: AppDb, accountId: string, scope: string, maxAgeMs: number, now: number = Date.now(),
): Promise<{ status: ScopeStatus; role: string | null }> {
  const rows = await db
    .select({ capturedAt: accountScopes.capturedAt, role: accountScopes.role })
    .from(accountScopes)
    .where(and(eq(accountScopes.accountId, accountId), eq(accountScopes.scope, scope)))
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
