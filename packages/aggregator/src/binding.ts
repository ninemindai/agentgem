// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/aggregator/binding.ts
// Records a server-verified pubkey -> account binding. Two proofs combine: the ed25519
// signature proves key possession; the token (verified live by AccountVerifier) proves
// account possession. Replays are idempotent; a signedAt freshness window blocks stale tokens.
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Auth, BetterAuthOptions } from "better-auth";
import { verify } from "@agentgem/model";
import { canonicalJSON } from "@agentgem/insight";
import type { AppDb } from "./schema.js";
import { accountBindings } from "./schema.js";
import type { AccountVerifier, OrgMembership } from "./accountVerifier.js";
import { fetchOrgMemberships } from "./accountVerifier.js";
import { upsertAccount, setAccountScopes } from "./webAuth.js";
import { claimHandleIfUnset } from "./handles.js";
import { ensureBetterAuthUser } from "./auth/migrateAccounts.js";
import { mintSession } from "./auth/mintSession.js";

export interface BindRequest { pubkey: string; token: string; signedAt: number; signature: string; }
export type BindResult =
  | { bound: true; provider: string; login: string; accountId: string; avatarUrl?: string; sessionToken?: string; expiresAt?: string }
  | { bound: false; rejected: "bad-signature" | "stale" | "unknown-producer" | "provider-error" };

const FRESHNESS_MS = 300_000;

/** The exact string the client signs and the server verifies. Signs over sha256(token) — never the
 *  raw token — so the secret stays out of the canonical (loggable) payload. */
export function bindSigningPayload(pubkey: string, token: string, signedAt: number): string {
  const tokenHash = createHash("sha256").update(token).digest("hex");
  return canonicalJSON({ pubkey, signedAt, tokenHash });
}

export async function recordBinding<O extends BetterAuthOptions>(
  db: AppDb, req: BindRequest, verifier: AccountVerifier, now: number = Date.now(),
  orgs: (token: string) => Promise<OrgMembership[]> = fetchOrgMemberships,
  auth?: Auth<O>,
): Promise<BindResult> {
  // 1. key possession (cheap, no DB, no leak)
  if (!verify(req.pubkey, bindSigningPayload(req.pubkey, req.token, req.signedAt), req.signature)) {
    return { bound: false, rejected: "bad-signature" };
  }
  // 2. freshness
  if (!Number.isFinite(req.signedAt) || Math.abs(now - req.signedAt) > FRESHNESS_MS) {
    return { bound: false, rejected: "stale" };
  }
  // 3. account possession (live) — verify the GitHub token BEFORE we register anything,
  // so an invalid/forged token can never create a producer row.
  let acct;
  try { acct = await verifier.verify(req.token); }
  catch { return { bound: false, rejected: "provider-error" }; }
  // 4. self-register the identity. A valid key signature + a live GitHub token are the only
  // proofs required to bind — connecting no longer presupposes prior telemetry. Insert the
  // producer if it's new (satisfies the account_bindings -> producers FK); existing producers
  // are untouched. Zero-attestation producers simply have nothing to show yet.
  await db.execute(sql`insert into producers (pubkey) values (${req.pubkey}) on conflict (pubkey) do nothing`);
  // 4b. reconcile with the web `accounts` identity + capture avatar, and capture the account row so
  // we can mint a session for it below. Best-effort: NEVER fail the bind over it — the
  // account_bindings write below is what ratings depend on. Without an account row we simply skip
  // the session (bind still succeeds; the client can reconnect for a session later).
  let account: Awaited<ReturnType<typeof upsertAccount>> | null = null;
  try {
    account = await upsertAccount(db, { provider: acct.provider, accountId: acct.accountId, login: acct.login, avatarUrl: acct.avatarUrl ?? null });
  } catch { /* avatar/profile is best-effort */ }
  // 4c. capture ORG memberships at bind, mirroring the web sign-in path — CLI-only users must pass
  // membership-gated reads (team usage) without ever visiting the web. Best-effort: an org-fetch
  // failure still binds; never fails the bind.
  //
  // The account's OWN namespace is not captured here. It is `"user".handle`, auto-claimed below
  // exactly as `anchorAndScopes` does on web sign-in, and read directly by accountSelfScope /
  // accountOwnsScope. This function used to write `{ scope: acct.login, role: "self" }`, and since
  // setAccountScopes REPLACES the whole set, a CLI `bind` silently reverted a renamed handle back to
  // the raw GitHub login — handing the renamer a `self` grant on whoever had since claimed the name
  // they abandoned. `ScopeGrant` no longer admits "self", so that regression cannot be reintroduced
  // without a type error.
  if (account) {
    try {
      let memberships: OrgMembership[] = [];
      try { memberships = await orgs(req.token); } catch { memberships = []; }
      await setAccountScopes(db, account.id, memberships.map((m) => ({ scope: m.login, role: m.role })));
    } catch { /* scopes are additive to the bind */ }
  }
  // 5. upsert (pubkey PK -> one account per key; rebind updates in place)
  await db.insert(accountBindings)
    .values({ pubkey: req.pubkey, provider: acct.provider, accountId: acct.accountId, accountLogin: acct.login })
    .onConflictDoUpdate({
      target: accountBindings.pubkey,
      set: { provider: acct.provider, accountId: acct.accountId, accountLogin: acct.login, boundAt: sql`now()` },
    });
  // 6. ensure the same-id better-auth `user` anchor, then auto-claim the handle. `"user".handle` is
  // where the account's own namespace lives now, so a CLI-only user who never opens the web app
  // still needs one to publish under their own name (accountOwnsScope reads it). This mirrors
  // `anchorAndScopes`' auto-claim exactly, including the `handle IS NULL` guard inside
  // claimHandleIfUnset that is what lets a rename survive a later re-bind.
  //
  // The anchor insert runs whether or not `auth` was supplied (it is the same raw-SQL insert
  // migrateAccountsToBetterAuth performs at boot, bypassing better-auth's adapter and the LOUD
  // anchorAndScopes create-hook); only the session mint needs `auth`. Both are additive — a failure
  // never fails the bind, which already succeeded above.
  let session: { sessionToken: string; expiresAt: string } | undefined;
  if (account) {
    try {
      await ensureBetterAuthUser(db, account);
      if (acct.provider === "github") await claimHandleIfUnset(db, account.id, acct.login);
    } catch { /* anchor + handle claim are additive; bind already succeeded */ }
    if (auth) {
      try {
        const { token, expiresAt } = await mintSession(auth, account.id);
        session = { sessionToken: token, expiresAt };
      } catch { /* session is additive; bind already succeeded */ }
    }
  }
  return { bound: true, provider: acct.provider, login: acct.login, accountId: acct.accountId, ...(acct.avatarUrl ? { avatarUrl: acct.avatarUrl } : {}), ...(session ?? {}) };
}
