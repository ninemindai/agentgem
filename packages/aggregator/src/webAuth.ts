// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Web account + session store. The session cookie carries an opaque random token; only its
// sha256 hash is persisted, so a DB leak cannot mint sessions.
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { AppDb } from "./schema.js";
import { accounts, webSessions } from "./schema.js";

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
