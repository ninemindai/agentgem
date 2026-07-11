// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Account-linking Flow B — the server-verified "other-account identity" seam (Task 0 spike outcome).
//
// SEAM DECISION: (b). better-auth's `linkSocial` does NOT hand Flow B the identity of a second
// provider that already belongs to another user. Its OAuth callback resolves that identity only as a
// transient local variable and, on the `account_already_linked_to_different_user` branch, redirects
// WITHOUT any DB write — no account row, no verification row, and its `databaseHooks.account.create`
// anchor hook never fires (createAccount is skipped). The OAuth `state` only ever carried the
// CALLER's own `{ userId, email }` (set at linkSocial time, before the other provider was known), so
// there is nothing there either. (Evidence: better-auth@1.6.23
// dist/api/routes/callback.mjs l.88/99/101, dist/api/routes/account.mjs l.178-181,
// dist/oauth2/state.mjs; reproduced by src/aggregator/__tests__/absorbSeam.spike.test.ts.)
//
// CONSEQUENCE FOR TASKS 5-6: Flow B cannot reuse `linkSocial` for the collision case. It needs a
// BESPOKE connect-OAuth callback route (`/api/account/connect/:provider/callback`, Task 6) that
// resolves the provider identity itself and stashes it, keyed to the caller's session, via
// `stashPendingLink` below. `/api/account/absorb` then reads it back via `pendingLink` — which
// derives the identity ONLY from that server-side record, never from a client-supplied id.
import { and, eq, gt } from "drizzle-orm";
import type { AppDb } from "../schema.js";
import { pendingAccountLinks } from "../schema.js";

export interface PendingLink {
  providerId: string;
  providerAccountId: string;
}

/** How long a resolved-but-unlinked provider identity stays claimable by absorb (Task 6 tunes). */
export const PENDING_LINK_TTL_MS = 10 * 60 * 1000;

/**
 * Bespoke-callback WRITE side (Task 6's `/api/account/connect/:provider/callback` calls this AFTER
 * it has verified the OAuth identity server-side). Records the single pending link for
 * `sessionUserId`, replacing any prior one. `link.providerAccountId` MUST originate from a
 * server-side OAuth exchange — never from a request body.
 */
export async function stashPendingLink(
  db: AppDb,
  sessionUserId: string,
  link: PendingLink,
  ttlMs: number = PENDING_LINK_TTL_MS,
): Promise<void> {
  const expiresAt = new Date(Date.now() + ttlMs);
  await db
    .insert(pendingAccountLinks)
    .values({ sessionUserId, providerId: link.providerId, providerAccountId: link.providerAccountId, expiresAt })
    .onConflictDoUpdate({
      target: pendingAccountLinks.sessionUserId,
      set: { providerId: link.providerId, providerAccountId: link.providerAccountId, expiresAt },
    });
}

/**
 * Return the server-verified identity of the provider the caller just OAuth'd but could not link
 * (because it belongs to another user), scoped to `sessionUserId`. `null` when there is no unexpired
 * pending link for this session. Identity is read ONLY from the server-side `pending_account_links`
 * record; there is deliberately no request-supplied-id parameter, so a client cannot name a victim.
 */
export async function pendingLink(db: AppDb, sessionUserId: string): Promise<PendingLink | null> {
  const rows = await db
    .select({
      providerId: pendingAccountLinks.providerId,
      providerAccountId: pendingAccountLinks.providerAccountId,
    })
    .from(pendingAccountLinks)
    .where(and(eq(pendingAccountLinks.sessionUserId, sessionUserId), gt(pendingAccountLinks.expiresAt, new Date())))
    .limit(1);
  const r = rows[0];
  return r ? { providerId: r.providerId, providerAccountId: r.providerAccountId } : null;
}
