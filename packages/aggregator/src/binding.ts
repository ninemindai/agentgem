// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/aggregator/binding.ts
// Records a server-verified pubkey -> account binding. Two proofs combine: the ed25519
// signature proves key possession; the token (verified live by AccountVerifier) proves
// account possession. Replays are idempotent; a signedAt freshness window blocks stale tokens.
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { verify } from "@agentgem/model";
import { canonicalJSON } from "@agentgem/insight";
import type { AppDb } from "./schema.js";
import { accountBindings } from "./schema.js";
import type { AccountVerifier } from "./accountVerifier.js";
import { upsertAccount } from "./webAuth.js";

export interface BindRequest { pubkey: string; token: string; signedAt: number; signature: string; }
export type BindResult =
  | { bound: true; provider: string; login: string; accountId: string; avatarUrl?: string }
  | { bound: false; rejected: "bad-signature" | "stale" | "unknown-producer" | "provider-error" };

const FRESHNESS_MS = 300_000;

/** The exact string the client signs and the server verifies. Signs over sha256(token) — never the
 *  raw token — so the secret stays out of the canonical (loggable) payload. */
export function bindSigningPayload(pubkey: string, token: string, signedAt: number): string {
  const tokenHash = createHash("sha256").update(token).digest("hex");
  return canonicalJSON({ pubkey, signedAt, tokenHash });
}

export async function recordBinding(
  db: AppDb, req: BindRequest, verifier: AccountVerifier, now: number = Date.now(),
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
  // 4b. reconcile with the web `accounts` identity + capture avatar. Best-effort: NEVER fail
  // the bind over it — the account_bindings write below is what ratings depend on.
  try {
    await upsertAccount(db, { provider: acct.provider, accountId: acct.accountId, login: acct.login, avatarUrl: acct.avatarUrl ?? null });
  } catch { /* avatar/profile is best-effort */ }
  // 5. upsert (pubkey PK -> one account per key; rebind updates in place)
  await db.insert(accountBindings)
    .values({ pubkey: req.pubkey, provider: acct.provider, accountId: acct.accountId, accountLogin: acct.login })
    .onConflictDoUpdate({
      target: accountBindings.pubkey,
      set: { provider: acct.provider, accountId: acct.accountId, accountLogin: acct.login, boundAt: sql`now()` },
    });
  return { bound: true, provider: acct.provider, login: acct.login, accountId: acct.accountId, ...(acct.avatarUrl ? { avatarUrl: acct.avatarUrl } : {}) };
}
