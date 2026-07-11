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
import { and, eq, gt, sql } from "drizzle-orm";
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

/**
 * Task 2: resolve a provider identity to its owning `accounts.id` uuid — PRIMARY or LINKED. The
 * legacy `accounts` anchor (Task 1) stores only the primary provider's `(provider,
 * providerAccountId)`, so joining/filtering against it silently fails for any provider a user
 * linked afterward. better-auth's own `account` table is authoritative for every provider it has
 * ever recorded for a user, and `account.user_id` equals the anchor's `accounts.id` uuid (the
 * anchor is always written with id = user.id — see anchorAndScopes). Callers that need to map a
 * desktop/producer-key `(provider, providerAccountId)` binding back to the account it authorizes
 * MUST use this instead of querying `accounts.provider`/`accounts.provider_account_id` directly.
 *
 * Falls back to the legacy `accounts` anchor when there is no `account` row: the mirror write
 * (anchorAndScopes on web sign-in, ensureBetterAuthUser on desktop bind) is best-effort and can be
 * skipped (see binding.ts's try/catch around it), so a legitimate anchor can outlive its mirror.
 * The fallback can only ever match a PRIMARY provider — Task 1 restricts the anchor to one row per
 * user — so it never mis-resolves a linked provider to the wrong owner.
 */
export async function accountIdForProvider(db: AppDb, providerId: string, providerAccountId: string): Promise<string | null> {
  const viaAccount = (await db.execute(sql`
    select user_id from account where provider_id = ${providerId} and account_id = ${providerAccountId} limit 1`)).rows;
  const resolved = (viaAccount?.[0] as { user_id?: string } | undefined)?.user_id ?? null;
  if (resolved) return resolved;
  const viaAnchor = (await db.execute(sql`
    select id as user_id from accounts where provider = ${providerId} and provider_account_id = ${providerAccountId} limit 1`)).rows;
  return (viaAnchor?.[0] as { user_id?: string } | undefined)?.user_id ?? null;
}

/**
 * Task 3 (Flow A): every provider id linked to `accountId` (better-auth's `user.id`, same value as
 * the `accounts` anchor's `id` — see anchorAndScopes), sorted. Reads `account` directly rather than
 * the legacy anchor because the anchor stamps only the PRIMARY provider (Task 1); a natively-linked
 * second provider (`account.accountLinking` in betterAuth.ts's makeAuth config) lives only here.
 */
export async function connectedProviders(db: AppDb, accountId: string): Promise<string[]> {
  const rows = (await db.execute(sql`select distinct provider_id from account where user_id = ${accountId} order by provider_id`)).rows ?? [];
  return rows.map((r: unknown) => (r as { provider_id: string }).provider_id);
}

/**
 * Task 4: the C-guard over EVERY table that FKs `accounts.id` — checked against `packages/
 * aggregator/src/schema.ts` (both the drizzle `.references(() => accounts.id)` declarations and
 * `ensureSchema`'s raw DDL, since `catalog_gems.owner_account_id` is only FK'd via the latter).
 * None of these FKs cascade on delete (see the file header / Task 5's absorb), so a stray child row
 * makes a later `DELETE accounts` throw. `handle` is not itself an accounts.id FK — `"user".id`
 * mirrors `accounts.id` 1:1 (see anchorAndScopes) — but a claimed handle is still a reason an
 * account cannot be silently absorbed/deleted, so it gates the same way.
 * Order is fixed on purpose: `blocker` names the FIRST non-empty source, so callers get a stable,
 * single reason rather than an unordered set.
 */
const FRESHNESS_CHECKS: Array<{ blocker: string; q: (id: string) => ReturnType<typeof sql> }> = [
  { blocker: "handle",        q: (id) => sql`select 1 from "user" where id = ${id} and handle is not null limit 1` },
  { blocker: "gem",           q: (id) => sql`select 1 from catalog_gems where owner_account_id = ${id} limit 1` },
  { blocker: "gem_archive",   q: (id) => sql`select 1 from gem_archives where owner_account_id = ${id} limit 1` },
  { blocker: "star",          q: (id) => sql`select 1 from stars where account_id = ${id} limit 1` },
  { blocker: "review",        q: (id) => sql`select 1 from reviews where account_id = ${id} limit 1` },
  { blocker: "group_member",  q: (id) => sql`select 1 from group_members where account_id = ${id} limit 1` },
  { blocker: "group_owner",   q: (id) => sql`select 1 from groups where created_by = ${id} limit 1` },
  { blocker: "group_invite",  q: (id) => sql`select 1 from group_invites where created_by = ${id} limit 1` },
  { blocker: "account_scope", q: (id) => sql`select 1 from account_scopes where account_id = ${id} limit 1` },
  { blocker: "usage",         q: (id) => sql`select 1 from usage_days where account_id = ${id} limit 1` },
  { blocker: "usage_model",   q: (id) => sql`select 1 from usage_day_models where account_id = ${id} limit 1` },
  { blocker: "handoff",       q: (id) => sql`select 1 from handoff_codes where account_id = ${id} limit 1` },
];

export async function accountFreshness(db: AppDb, accountId: string): Promise<{ fresh: boolean; blocker: string | null }> {
  for (const c of FRESHNESS_CHECKS) {
    const hit = (await db.execute(c.q(accountId))).rows?.length ?? 0;
    if (hit > 0) return { fresh: false, blocker: c.blocker };
  }
  return { fresh: true, blocker: null };
}
