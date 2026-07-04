// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Web account + session store. The session cookie carries an opaque random token; only its
// sha256 hash is persisted, so a DB leak cannot mint sessions.
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
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
  a: { provider: string; accountId: string; login: string; avatarUrl?: string | null },
): Promise<Account> {
  const id = randomUUID();
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

export async function createSession(db: AppDb, accountId: string, token: string, ttlMs: number): Promise<void> {
  await db.insert(webSessions).values({
    id: randomUUID(),
    tokenHash: sha256hex(token),
    accountId,
    expiresAt: new Date(Date.now() + ttlMs),
  });
}

export async function resolveSession(db: AppDb, token: string): Promise<{ login: string; avatarUrl: string | null; accountId: string } | null> {
  const rows = await db
    .select({ login: accounts.login, avatarUrl: accounts.avatarUrl, accountId: accounts.id })
    .from(webSessions)
    .innerJoin(accounts, eq(webSessions.accountId, accounts.id))
    .where(and(eq(webSessions.tokenHash, sha256hex(token)), gt(webSessions.expiresAt, new Date())))
    .limit(1);
  return rows[0] ?? null;
}

export async function deleteSession(db: AppDb, token: string): Promise<void> {
  await db.delete(webSessions).where(eq(webSessions.tokenHash, sha256hex(token)));
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

/** REPLACE the account's owned scope set (login + org logins). Deduped; empty clears it. */
export async function setAccountScopes(db: AppDb, accountId: string, scopes: string[]): Promise<void> {
  const unique = [...new Set(scopes)];
  await db.delete(accountScopes).where(eq(accountScopes.accountId, accountId));
  if (unique.length > 0) {
    await db.insert(accountScopes).values(unique.map((scope) => ({ accountId, scope })));
  }
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
