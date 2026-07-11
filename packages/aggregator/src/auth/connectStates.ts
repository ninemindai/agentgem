// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { and, eq, gt, lt } from "drizzle-orm";
import type { AppDb } from "../schema.js";
import { connectStates } from "../schema.js";

export const CONNECT_STATE_TTL_MS = 10 * 60 * 1000;

/** WRITE side of the bespoke connect start route: one in-flight OAuth per state, bound to the
 *  caller's session user. `stateHash` is sha256(state) — never store the raw state.
 *
 *  Unlike `pending_account_links` (one row per user, PK'd on session_user_id), this table gets a
 *  new row per connect start, and `consumeConnectState` only ever *skips* expired rows via its
 *  `expires_at > now()` filter — it never deletes them. Reap expired rows here as a side effect of
 *  normal use so the table doesn't grow unbounded for a user who repeatedly starts connect. */
export async function stashConnectState(
  db: AppDb,
  row: { stateHash: string; codeVerifier: string; currentUserId: string; provider: string },
  ttlMs: number = CONNECT_STATE_TTL_MS,
): Promise<void> {
  await db.delete(connectStates).where(lt(connectStates.expiresAt, new Date()));
  const expiresAt = new Date(Date.now() + ttlMs);
  await db.insert(connectStates).values({ ...row, expiresAt }).onConflictDoNothing();
}

/** One-time READ: return the row for `stateHash` and DELETE it. `null` if absent or expired.
 *  This is what makes the connect callback's identity binding (currentUserId) come only from the
 *  server-stored start, never from the callback request. */
export async function consumeConnectState(
  db: AppDb,
  stateHash: string,
): Promise<{ codeVerifier: string; currentUserId: string; provider: string } | null> {
  const rows = await db
    .delete(connectStates)
    .where(and(eq(connectStates.stateHash, stateHash), gt(connectStates.expiresAt, new Date())))
    .returning({ codeVerifier: connectStates.codeVerifier, currentUserId: connectStates.currentUserId, provider: connectStates.provider });
  return rows[0] ?? null;
}
