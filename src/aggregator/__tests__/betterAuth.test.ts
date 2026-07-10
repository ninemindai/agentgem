// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, makeAuth, mintSession, setAccountScopes, upsertAccount } from "@agentgem/aggregator";

const opts = {
  secret: "test-secret",
  baseURL: "http://localhost:4000",
  githubClientId: "gid",
  githubClientSecret: "gsecret",
  webOrigins: ["http://localhost:3000"],
};

describe("betterAuth factory", () => {
  it("constructs over makeTestDb() and rejects an unknown bearer", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...opts });
    const session = await auth.api.getSession({ headers: new Headers({ authorization: "Bearer nope" }) });
    expect(session).toBeNull();
  });

  it("forces uuid ids via advanced.database.generateId", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...opts });
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser({ email: "neo@example.com", name: "Neo", emailVerified: false } as never);
    expect(user.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("mints a session with a 30-day TTL", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...opts });
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser({ email: "trinity@example.com", name: "Trinity", emailVerified: false } as never);
    const before = Date.now();
    const session = await ctx.internalAdapter.createSession(user.id, undefined);
    const expiresAt = new Date(session.expiresAt).getTime();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    expect(expiresAt).toBeGreaterThan(before + thirtyDaysMs - 60_000);
    expect(expiresAt).toBeLessThan(before + thirtyDaysMs + 60_000);
  });

  // review fix (1b-2) — restore `orgs` on get-session via the customSession plugin, matching the
  // OLD /api/auth/me contract. account_scopes now holds ORG memberships only (the caller's own name
  // is "user".handle), so `orgs` is the whole table for this account, and the defensive
  // `role !== "self"` filter guards only legacy rows that ensureSchema has yet to drain.
  it("enriches get-session with orgs from account_scopes, excluding any legacy self scope", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...opts });
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser({ email: "trinity@example.com", name: "Trinity", emailVerified: false, login: "trinity" } as never);
    // account_scopes.account_id FKs to the legacy `accounts` table — in production the
    // databaseHooks.account.create hook (anchorAndScopes) writes this anchor row on real sign-in;
    // here we drive the user through internalAdapter directly, so anchor it by hand.
    await upsertAccount(db, { provider: "github", accountId: "gh-trinity", login: "trinity", avatarUrl: null, id: user.id });
    await setAccountScopes(db, user.id, [
      { scope: "zion", role: "admin" },
      { scope: "matrix", role: "member" },
    ]);
    // A legacy mirror row, insertable only via raw SQL now — customSession must still hide it.
    await db.execute(sql`insert into account_scopes (account_id, scope, role) values (${user.id}, 'trinity', 'self')`);
    const { token } = await mintSession(auth, user.id);

    const session = await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) });

    // The `resolveSession` shim (webAuth.ts) reads `res?.user` off exactly this payload — must
    // still be there, untouched, alongside the new `orgs` field.
    expect((session as { user?: { id: string } })?.user?.id).toBe(user.id);
    expect((session as { orgs?: unknown })?.orgs).toEqual([
      { scope: "matrix", role: "member" },
      { scope: "zion", role: "admin" },
    ]);
  });

  // Final-review fix 1b-5 — better-auth's own inner session lookup is wrapped in `.catch(() => null)`,
  // but the customSession enrichment fn is NOT, so an uncaught throw from getAccountScopes would
  // reject auth.api.getSession() entirely — and every one of resolveSession's 9 route consumers awaits
  // that call directly, so a transient scopes-read failure would 500 an unrelated authed request
  // (stars, reviews, publish...) instead of just losing `orgs`. Force a real throw by dropping the
  // account_scopes table out from under a live db, and assert getSession still resolves the user.
  it("still authenticates (with empty orgs) when getAccountScopes throws", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...opts });
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser({ email: "morpheus@example.com", name: "Morpheus", emailVerified: false, login: "morpheus" } as never);
    await upsertAccount(db, { provider: "github", accountId: "gh-morpheus", login: "morpheus", avatarUrl: null, id: user.id });
    await setAccountScopes(db, user.id, [{ scope: "zion", role: "admin" }]);
    const { token } = await mintSession(auth, user.id);

    await db.execute(sql`drop table account_scopes`);

    const session = await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) });

    expect((session as { user?: { id: string } })?.user?.id).toBe(user.id);
    expect((session as { orgs?: unknown })?.orgs).toEqual([]);
  });

  it("returns an empty orgs array when the account belongs to no orgs", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...opts });
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser({ email: "neo@example.com", name: "Neo", emailVerified: false, login: "neo" } as never);
    await upsertAccount(db, { provider: "github", accountId: "gh-neo", login: "neo", avatarUrl: null, id: user.id });
    await setAccountScopes(db, user.id, []);
    const { token } = await mintSession(auth, user.id);

    const session = await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) });
    expect((session as { orgs?: unknown })?.orgs).toEqual([]);
  });

  it("registers Google iff both Google creds are supplied; GitHub is unaffected", async () => {
    const db = await makeTestDb();
    const withGoogle = makeAuth({ db, ...opts, googleClientId: "gid", googleClientSecret: "gsec" });
    const provWith = Object.keys((withGoogle.options.socialProviders ?? {}) as Record<string, unknown>).sort();
    expect(provWith).toEqual(["github", "google"]);

    const noGoogle = makeAuth({ db, ...opts });
    const provNone = Object.keys((noGoogle.options.socialProviders ?? {}) as Record<string, unknown>);
    expect(provNone).toEqual(["github"]);

    // one cred without the other must NOT register google (fail closed on partial config)
    const partial = makeAuth({ db, ...opts, googleClientId: "gid" });
    expect(Object.keys((partial.options.socialProviders ?? {}) as Record<string, unknown>)).toEqual(["github"]);
  });
});
