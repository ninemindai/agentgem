// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, makeAuth, mintSession, setAccountScopes, upsertAccount, connectedProviders, handleForAccountId } from "@agentgem/aggregator";

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

  it("linking a second provider adds no second accounts anchor and does not throw", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...opts });
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser({ email: "neo@x.com", name: "Neo", emailVerified: false, login: "neo" } as never);
    // Primary provider anchor (as anchorAndScopes writes it on first github sign-in):
    await upsertAccount(db, { provider: "github", accountId: "gh-neo", login: "neo", avatarUrl: null, id: user.id });
    // Simulate the account.create hook firing for a SECOND provider on the same user:
    await expect(
      (async () => {
        const { anchorAndScopesForTest } = await import("@agentgem/aggregator");
        await anchorAndScopesForTest(db, { userId: user.id, providerId: "google", accountId: "goog-neo", accessToken: null }, true);
      })()
    ).resolves.not.toThrow();
    const rows = await db.execute(sql`select provider, login from accounts where id = ${user.id}`);
    expect(rows.rows).toHaveLength(1);
    expect((rows.rows[0] as { provider: string }).provider).toBe("github"); // primary stamp unchanged
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

  // Task 3 — Flow A (connecting a provider you've never separately used) relies on better-auth's
  // native linkSocial, gated entirely by this config: trustedProviders skips the email-ownership
  // re-verification step for github/google (both first-party OAuth apps already used for primary
  // sign-in), and allowDifferentEmails is what permits linking a provider whose account uses a
  // different email than the caller's primary (a github user signed in as A@x.com linking a google
  // account B@y.com) — without it, better-auth would reject that pairing.
  it("enables native account linking with trusted providers and allowDifferentEmails at the config level", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...opts, googleClientId: "gid", googleClientSecret: "gsec" });
    expect(auth.options.account?.accountLinking).toEqual({
      enabled: true,
      trustedProviders: ["github", "google", "twitter"],
      allowDifferentEmails: true,
    });
  });

  // X (better-auth keeps the internal key `twitter`) is additive and optional, exactly like Google:
  // registered only when BOTH creds are present, so a partial config fails closed and never exposes a
  // half-wired provider. GitHub — the gate for mounting auth at all — is unaffected either way.
  it("registers Twitter (X) iff both twitter creds are supplied; GitHub is unaffected", async () => {
    const db = await makeTestDb();
    const withX = makeAuth({ db, ...opts, twitterClientId: "xid", twitterClientSecret: "xsec" });
    expect(Object.keys((withX.options.socialProviders ?? {}) as Record<string, unknown>).sort())
      .toEqual(["github", "twitter"]);

    const noX = makeAuth({ db, ...opts });
    expect(Object.keys((noX.options.socialProviders ?? {}) as Record<string, unknown>)).toEqual(["github"]);

    // one cred without the other must NOT register twitter (fail closed on partial config)
    const partial = makeAuth({ db, ...opts, twitterClientId: "xid" });
    expect(Object.keys((partial.options.socialProviders ?? {}) as Record<string, unknown>)).toEqual(["github"]);
  });

  // X's OAuth returns a real email ONLY for email-approved apps; better-auth's own fallback would then
  // store the username string AS the email. better-auth requires a non-null email STRING at user
  // creation, so our mapProfileToUser supplies a synthetic noreply address (mirroring the GitHub
  // `@users.noreply.github.com` fallback) and lifts the X username into `login` for the handle claim.
  it("twitter mapProfileToUser sets login + a synthetic noreply email when X returns none", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...opts, twitterClientId: "xid", twitterClientSecret: "xsec" });
    const twitter = (auth.options.socialProviders as Record<string, { mapProfileToUser?: (p: unknown) => unknown }>).twitter;
    const mapped = twitter.mapProfileToUser?.({
      data: { id: "42", username: "neo", name: "Neo", profile_image_url: "https://x/pic.jpg" },
    }) as { login: string; name: string; image: string; email: string };
    expect(mapped.login).toBe("neo");
    expect(mapped.name).toBe("Neo");
    expect(mapped.image).toBe("https://x/pic.jpg");
    expect(mapped.email).toBe("neo@users.noreply.x.com");

    // a real confirmed_email (set by better-auth onto profile.data.email) is preserved as-is
    const withEmail = twitter.mapProfileToUser?.({
      data: { id: "7", username: "trin", name: "Trinity", email: "trin@real.com" },
    }) as { email: string };
    expect(withEmail.email).toBe("trin@real.com");
  });

  // Auto-claim parity with GitHub (the decision for X): a first X sign-in claims the X username as the
  // public @handle if free. The GitHub org-membership fetch is GitHub-specific and must NOT fire for X
  // even when an access token is present — so passing a token here still claims the handle and writes
  // no org scopes (proving the claim moved ABOVE the github-only guard, and the guard still returns).
  it("auto-claims the X username as handle on first twitter sign-in, without fetching GitHub orgs", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...opts, twitterClientId: "xid", twitterClientSecret: "xsec" });
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: "neo@users.noreply.x.com", name: "Neo", emailVerified: false, login: "neoX" } as never,
    );
    const { anchorAndScopesForTest } = await import("@agentgem/aggregator");
    await anchorAndScopesForTest(
      db, { userId: user.id, providerId: "twitter", accountId: "tw-neo", accessToken: "would-be-github-token" }, true,
    );
    expect(await handleForAccountId(db, user.id)).toBe("neoX");
    const anchor = await db.execute(sql`select provider, login from accounts where id = ${user.id}`);
    expect(anchor.rows).toHaveLength(1);
    expect((anchor.rows[0] as { provider: string; login: string }).provider).toBe("twitter");
    expect((anchor.rows[0] as { provider: string; login: string }).login).toBe("neoX");
    // No org scopes: the GitHub org API is never called for a twitter sign-in.
    const scopes = await db.execute(sql`select 1 from account_scopes where account_id = ${user.id}`);
    expect(scopes.rows).toHaveLength(0);
  });

  it("linking a second provider (native account linking) leaves one accounts anchor and connectedProviders lists both", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...opts, googleClientId: "gid", googleClientSecret: "gsec" });
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser({ email: "flowa@x.com", name: "FlowA", emailVerified: false, login: "flowa" } as never);
    // Primary provider anchor (github), as anchorAndScopes writes it on first sign-in (Task 1: per-user, idempotent).
    await upsertAccount(db, { provider: "github", accountId: "gh-flowa", login: "flowa", avatarUrl: null, id: user.id });
    // Simulate better-auth's native linkSocial (gated by the account.accountLinking config above)
    // having recorded a second, DIFFERENT-EMAIL provider (google) for the SAME user — this is the
    // shape allowDifferentEmails permits. linkSocial itself only ever writes to better-auth's own
    // `account` table; the legacy `accounts` anchor gets no second row (Task 1).
    await db.execute(sql`insert into account (id, user_id, account_id, provider_id, created_at, updated_at) values
      (gen_random_uuid()::text, ${user.id}, 'gh-flowa', 'github', now(), now()),
      (gen_random_uuid()::text, ${user.id}, 'goog-flowa', 'google', now(), now())`);

    const rows = await db.execute(sql`select provider from accounts where id = ${user.id}`);
    expect(rows.rows).toHaveLength(1); // still exactly one anchor, primary provider unchanged
    expect(await connectedProviders(db, user.id)).toEqual(["github", "google"]);
  });
});
