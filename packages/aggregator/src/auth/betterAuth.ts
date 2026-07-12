// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { betterAuth } from "better-auth";
import type { Auth, BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins";
import { customSession } from "better-auth/plugins/custom-session";
import { oneTimeToken } from "better-auth/plugins/one-time-token";
import { passkey } from "@better-auth/passkey";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { AppDb } from "../schema.js";
import { fetchOrgMemberships } from "../accountVerifier.js";
import { setAccountScopes, upsertAccount, getAccountScopes } from "../webAuth.js";
import { claimHandleIfUnset } from "../handles.js";

const SESSION_TTL_S = 30 * 24 * 60 * 60; // 30 days — matches web_sessions/binding today (review fix 2A)

export function makeAuth(opts: {
  db: AppDb; secret: string; baseURL: string; githubClientId: string; githubClientSecret: string;
  googleClientId?: string; googleClientSecret?: string;
  webOrigins: string[]; cookieDomain?: string;
  passkeyRpId?: string; passkeyOrigins?: string[]; rpName?: string;
}): Auth<BetterAuthOptions> {
  // Widened to `BetterAuthOptions` (rather than letting TS infer the literal options-object type)
  // so the exported `makeAuth`'s return type doesn't need to structurally encode the
  // `customSession` plugin's Zod query-schema type in its declaration (.d.ts) — that inferred type
  // references a Zod internal (`$strip`) that isn't independently nameable across this monorepo's
  // pnpm layout, which trips `tsc -b`'s TS2883 ("inferred type ... cannot be named"). `Auth<O>` is
  // invariant in O (see resolveSession's comment in ../webAuth.ts), so this widening has to happen
  // on the OPTIONS passed to `betterAuth(...)`, not via a return-type annotation/cast on its result.
  const config: BetterAuthOptions = {
    database: drizzleAdapter(opts.db as never, { provider: "pg" }),
    secret: opts.secret,
    baseURL: opts.baseURL,
    trustedOrigins: opts.webOrigins,                    // review fix #6 — redirect/CSRF boundary
    emailAndPassword: { enabled: false },
    // review fix (1b-2) — restore `orgs` on the session payload via better-auth's own enrichment
    // seam instead of hand-rolling a parallel endpoint. Mirrors the OLD /api/auth/me contract
    // exactly (src/auth/install.ts meHandler): getAccountScopes minus the caller's own "self"
    // scope, mapped to { scope, role }, sorted by scope. `user`/`session` are passed through
    // unchanged so resolveSession's `res?.user` shim keeps working.
    plugins: [bearer(), customSession(async ({ user, session }) => {
      // Final-review fix 1b-5 — better-auth wraps its OWN inner session lookup in `.catch(() =>
      // null)`, but NOT this enrichment fn: an uncaught throw here (e.g. a transient DB error from
      // getAccountScopes) would reject customSession's override of /get-session entirely, which
      // resolveSession (called by all route consumers) awaits directly — so a scopes read failure
      // would 500 an otherwise-unrelated authed request (stars, reviews, publish...) instead of just
      // degrading. Scope enrichment must never fail auth resolution.
      try {
        const orgs = (await getAccountScopes(opts.db, user.id))
          .filter((s) => s.role !== "self")
          .map((s) => ({ scope: s.scope, role: s.role }))
          .sort((a, b) => a.scope.localeCompare(b.scope));
        return { user, session, orgs };
      } catch {
        return { user, session, orgs: [] };
      }
    }),
    // 1b-Task 4 — the SSO handoff redeem's ONLY way to hand the browser a genuine better-auth
    // session cookie without hand-signing one: mintSessionCookie (mintCookie.ts) drives this
    // plugin's generate+verify pair in-process to exchange a just-minted session's raw token for
    // the real Set-Cookie better-auth's own setSessionCookie() produces. expiresIn is minutes;
    // 1 is already generous since verify consumes (deletes) the exchange token on first read and
    // mintSessionCookie redeems it within the same request. storeToken: "hashed" (defense-in-depth,
    // 1b-Task 5) — the exchange token would otherwise be persisted in plaintext for that one minute.
    oneTimeToken({ expiresIn: 1, storeToken: "hashed" }),
    // Passkey (WebAuthn) passwordless sign-in. rpID MUST be a registrable suffix of the page origin
    // (app.agentgem.ai) — the api.agentgem.ai baseURL default would fail verification — so the caller
    // (src/index.ts) passes agentgem.ai, mirroring crossSubDomainCookies. `origin` is the allowed page
    // origin(s); it defaults to webOrigins. requireSession stays default (true): a passkey always
    // attaches to the caller's existing social session (there is no passkey-first onboarding).
    passkey({ rpID: opts.passkeyRpId, rpName: opts.rpName ?? "AgentGem", origin: opts.passkeyOrigins ?? opts.webOrigins })],
    // review fix #1/#14 — force uuid ids so downstream uuid FKs (accounts.id, stars.account_id, ...) work
    advanced: {
      database: { generateId: () => randomUUID() },
      // review fix #4 — cross-subdomain cookie so app.agentgem.ai sends it to api.agentgem.ai
      ...(opts.cookieDomain ? { crossSubDomainCookies: { enabled: true, domain: opts.cookieDomain } } : {}),
    },
    session: { expiresIn: SESSION_TTL_S, updateAge: 60 * 60 * 24 },   // review fix 2A
    user: { additionalFields: {
      login: { type: "string", required: false },
      // The re-key made `handle` a column on "user" (the account's public name; NULL until claimed).
      // Surfacing it here lets the SPA tell a handle-less account (a fresh Google user) from a named
      // one, which is what gates the lazy handle-claim flow. additionalFields reads the column
      // directly — no query change.
      handle: { type: "string", required: false },
    } },
    socialProviders: {
      github: {
        clientId: opts.githubClientId, clientSecret: opts.githubClientSecret,
        scope: ["read:user", "read:org"],
        // GitHub returns email:null for accounts without a public email even after better-auth fetches
        // /user/emails; better-auth requires a non-null email STRING (user creation + linkSocial's
        // OAuth state), so a null there is an unhandled 500 on the Connect callback. Fall back to the
        // noreply address — matches backfillUserEmails (schema.ts) for existing rows, so re-login on a
        // backfilled account is a no-op rather than churn.
        mapProfileToUser: (p: any) => ({
          login: p.login, name: p.name ?? p.login, image: p.avatar_url,
          email: p.email ?? `${p.login ?? p.id}@users.noreply.github.com`,
        }),
      },
      // Google is additive and optional — registered only when BOTH creds are present (a partial
      // config registers nothing, failing closed). Non-sensitive scopes only. Google supplies no
      // username, so mapProfileToUser sets name + image and NO login; the re-key's anchorAndScopes
      // writes a NULL-login accounts anchor for any non-github provider, and the handle stays NULL
      // until the user claims one.
      ...(opts.googleClientId && opts.googleClientSecret ? {
        google: {
          clientId: opts.googleClientId, clientSecret: opts.googleClientSecret,
          scope: ["openid", "email", "profile"],
          mapProfileToUser: (p: any) => ({ name: p.name ?? p.email, image: p.picture }),
        },
      } : {}),
    },
    databaseHooks: {
      account: {
        // review fix 1A — capture org scopes on FIRST login (create) AND every re-login (update),
        // so account_scopes stays fresh and org offboarding works. Also writes the legacy accounts
        // anchor so EVERY better-auth user has a same-id accounts row (review fix #1 new-user anchor).
        create: { after: async (a) => anchorAndScopes(opts.db, a, true) },
        update: { after: async (a) => anchorAndScopes(opts.db, a, false) },
      },
    },
    // Task 3 (Flow A) — enable better-auth's native `linkSocial` so a signed-in user can connect a
    // provider they've never separately used. github/google are trusted (same first-party OAuth
    // apps already used for primary sign-in, per socialProviders above) and allowDifferentEmails is
    // required because the whole point of Flow A is linking a provider whose email may not match the
    // caller's primary email. The anchor stays per-user/idempotent (Task 1) — a linked provider adds
    // only an `account` row, never a second `accounts` anchor.
    account: {
      accountLinking: { enabled: true, trustedProviders: ["github", "google"], allowDifferentEmails: true },
    },
  };
  return betterAuth(config);
}

export async function anchorAndScopesForTest(
  db: AppDb,
  account: { userId: string; providerId: string; accountId: string; accessToken?: string | null },
  isCreate: boolean,
) { return anchorAndScopes(db, account, isCreate); }

async function anchorAndScopes(
  db: AppDb,
  account: { userId: string; providerId: string; accountId: string; accessToken?: string | null },
  isCreate: boolean,
) {
  const row = (await db.execute(sql`select login, image from "user" where id = ${account.userId}`)).rows?.[0] as
    { login?: string; image?: string } | undefined;
  // GitHub supplies a login; every other provider does not. The anchor row is written either way,
  // because ten tables carry a foreign key to accounts.id and the user's first star/review/group
  // insert would otherwise violate it. A login-less anchor is legal since Task 1 (login is nullable).
  const login = account.providerId === "github" ? (row?.login ?? null) : null;

  // The anchor is PER-USER: one row per user.id, stamped by the FIRST provider that created it.
  // A second linked provider needs NO new anchor — the existing one already authorizes the user,
  // and accounts.id is a PK, so writing a second row for the same user.id is a duplicate-PK throw.
  // better-auth's `account` table holds the per-provider records natively; the anchor never does.
  const existing = (await db.execute(sql`select 1 from accounts where id = ${account.userId} limit 1`)).rows?.length ?? 0;
  if (existing === 0) {
    // On CREATE the anchor is LOAD-BEARING: a user with no anchor is broken and must not get a
    // session, so let a failure THROW and abort the sign-in. On UPDATE (re-login) the anchor already
    // exists and we are only refreshing login/avatar — best-effort, never block a legitimate sign-in.
    const write = () => upsertAccount(db, {
      provider: account.providerId, accountId: account.accountId,
      login, avatarUrl: row?.image ?? null, id: account.userId,
    });
    if (isCreate) await write();
    else try { await write(); } catch { /* re-login refresh is best-effort */ }
  }

  // Org scopes are a GitHub concept: they are captured from the GitHub App / API and keyed on a
  // login. A login-less provider simply has none, matches no org, and is denied — correct, not a gap.
  // The provider check is REDUNDANT today (`login` is null for every non-github provider, computed
  // above) and so cannot be falsified by a test. Keep it: the day a non-github provider starts
  // supplying a `login`, it is the only thing stopping us from calling GitHub's org API with that
  // provider's access token. Do not "simplify" it away to `if (!login) return`.
  if (account.providerId !== "github" || !login) return;

  // Identity re-key (Task 5b): a GitHub sign-in with no handle yet claims one for free, so an
  // existing user (backfilled by backfillUserHandles) or a brand-new signup both end up claimed
  // without ever seeing the claim flow. Guarded by claimHandleIfUnset itself — reserved/taken names
  // simply don't claim — and gated on `handle IS NULL`, which is what makes a RENAME SURVIVE
  // RE-LOGIN: once a user has claimed a different handle, this is a no-op, and the self-scope
  // below is written from that handle, not unconditionally from `login`.
  try { await claimHandleIfUnset(db, account.userId, login); } catch { /* best-effort */ }

  try {
    if (account.accessToken) {
      // ORG memberships only. The account's own namespace is `"user".handle` (claimed just above),
      // read directly by accountSelfScope/accountOwnsScope — it is never mirrored into a scope row.
      // Writing one here is what used to let `recordBinding` and this hook disagree about the
      // account's name; `ScopeGrant` no longer admits a "self" role, so the drift is a type error.
      const memberships = await fetchOrgMemberships(account.accessToken);
      await setAccountScopes(db, account.userId, memberships.map((m) => ({ scope: m.login, role: m.role })));
    }
  } catch { /* scopes are additive; never fail sign-in over them */ }
}
