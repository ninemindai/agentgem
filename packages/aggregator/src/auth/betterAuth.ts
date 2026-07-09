// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { AppDb } from "../schema.js";
import { fetchOrgMemberships } from "../accountVerifier.js";
import { setAccountScopes, upsertAccount } from "../webAuth.js";

const SESSION_TTL_S = 30 * 24 * 60 * 60; // 30 days — matches web_sessions/binding today (review fix 2A)

export function makeAuth(opts: {
  db: AppDb; secret: string; baseURL: string; githubClientId: string; githubClientSecret: string;
  webOrigins: string[]; cookieDomain?: string;
}) {
  return betterAuth({
    database: drizzleAdapter(opts.db as never, { provider: "pg" }),
    secret: opts.secret,
    baseURL: opts.baseURL,
    trustedOrigins: opts.webOrigins,                    // review fix #6 — redirect/CSRF boundary
    emailAndPassword: { enabled: false },
    plugins: [bearer()],
    // review fix #1/#14 — force uuid ids so downstream uuid FKs (accounts.id, stars.account_id, ...) work
    advanced: {
      database: { generateId: () => randomUUID() },
      // review fix #4 — cross-subdomain cookie so app.agentgem.ai sends it to api.agentgem.ai
      ...(opts.cookieDomain ? { crossSubDomainCookies: { enabled: true, domain: opts.cookieDomain } } : {}),
    },
    session: { expiresIn: SESSION_TTL_S, updateAge: 60 * 60 * 24 },   // review fix 2A
    user: { additionalFields: { login: { type: "string", required: false } } },
    socialProviders: {
      github: {
        clientId: opts.githubClientId, clientSecret: opts.githubClientSecret,
        scope: ["read:user", "read:org"],
        mapProfileToUser: (p: any) => ({ login: p.login, name: p.name ?? p.login, image: p.avatar_url }),
      },
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
  });
}

async function anchorAndScopes(db: AppDb, account: { userId: string; providerId: string; accountId: string; accessToken?: string | null }, isCreate: boolean) {
  if (account.providerId !== "github") return;
  const row = (await db.execute(sql`select login, image from "user" where id = ${account.userId}`)).rows?.[0] as { login?: string; image?: string } | undefined;
  const login = row?.login;
  // 1) legacy accounts ANCHOR. accounts.id = user.id (uuid). No existing row for a new user, so the
  //    insert with id=user.id succeeds; a migrated user re-logging in already has id=user.id, so the
  //    (provider,provider_account_id) conflict updates login/avatar in place (id unchanged). Mismatched
  //    ids are caught by the migration conflict check (1a-Task 5), so they cannot reach here.
  //    On CREATE, the write is LOAD-BEARING — let a failure THROW to fail the sign-in, since a user
  //    with no anchor is broken and must not get a session.
  //    On UPDATE (re-login), the anchor already exists — the write is just refreshing login/avatar,
  //    so it's best-effort: a transient failure here must not block an otherwise-legitimate sign-in.
  if (login) {
    if (isCreate) {
      await upsertAccount(db, { provider: "github", accountId: account.accountId, login, avatarUrl: row?.image ?? null, id: account.userId } as never);
    } else {
      try {
        await upsertAccount(db, { provider: "github", accountId: account.accountId, login, avatarUrl: row?.image ?? null, id: account.userId } as never);
      } catch { /* re-login refresh is best-effort; the anchor already exists */ }
    }
  } else if (isCreate) {
    throw new Error("anchor: user has no login; cannot create accounts anchor");
  }
  // 2) org scopes — best-effort, never throw (mirrors today's tolerance).
  try {
    if (account.accessToken && login) {
      const memberships = await fetchOrgMemberships(account.accessToken);
      await setAccountScopes(db, account.userId, [{ scope: login, role: "self" as const }, ...memberships.map((m) => ({ scope: m.login, role: m.role }))]);
    }
  } catch { /* scopes are additive; never fail sign-in over them */ }
}
