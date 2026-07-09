// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
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
  // OLD /api/auth/me contract exactly: getAccountScopes minus the caller's own "self" scope.
  it("enriches get-session with orgs from account_scopes, excluding the caller's own self scope", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...opts });
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser({ email: "trinity@example.com", name: "Trinity", emailVerified: false, login: "trinity" } as never);
    // account_scopes.account_id FKs to the legacy `accounts` table — in production the
    // databaseHooks.account.create hook (anchorAndScopes) writes this anchor row on real sign-in;
    // here we drive the user through internalAdapter directly, so anchor it by hand.
    await upsertAccount(db, { provider: "github", accountId: "gh-trinity", login: "trinity", avatarUrl: null, id: user.id });
    await setAccountScopes(db, user.id, [
      { scope: "trinity", role: "self" },
      { scope: "zion", role: "admin" },
      { scope: "matrix", role: "member" },
    ]);
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

  it("returns an empty orgs array when the account owns no scopes beyond its own self scope", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...opts });
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser({ email: "neo@example.com", name: "Neo", emailVerified: false, login: "neo" } as never);
    await upsertAccount(db, { provider: "github", accountId: "gh-neo", login: "neo", avatarUrl: null, id: user.id });
    await setAccountScopes(db, user.id, [{ scope: "neo", role: "self" }]);
    const { token } = await mintSession(auth, user.id);

    const session = await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) });
    expect((session as { orgs?: unknown })?.orgs).toEqual([]);
  });
});
