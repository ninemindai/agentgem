// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// 1a-Task 6: closes the memory-adapter gap. Earlier spikes (betterAuth.test.ts, mintSession.test.ts)
// only proved createUser/createSession over the real drizzle+PGlite adapter — none of them ever
// called createAccount/updateAccount, so the databaseHooks.account.create/update.after hook
// (anchorAndScopes in betterAuth.ts) has never fired over anything but better-auth's memory
// adapter in a spike. This test drives it over makeTestDb() (real drizzle-over-PGlite).
import { describe, it, expect, afterEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, makeAuth, mintSession } from "@agentgem/aggregator";

const opts = {
  secret: "test-secret",
  baseURL: "http://localhost:4000",
  githubClientId: "gid",
  githubClientSecret: "gsecret",
  webOrigins: ["http://localhost:3000"],
};

// anchorAndScopes calls fetchOrgMemberships(accessToken) with no injectable fetchImpl, so it hits
// the real `fetch` global. Stub it so the test is deterministic/offline rather than depending on a
// live (and, with a fake token, failing) network call. A 401 is exactly what a fake token gets in
// production; fetchOrgMemberships treats any non-2xx as "no memberships" (see accountVerifier.ts),
// so this exercises the same degrade path production hits for a bad/expired token.
function stubGithubMembershipsFetch() {
  vi.stubGlobal("fetch", (async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch);
}

async function createGithubUser(db: Awaited<ReturnType<typeof makeTestDb>>, auth: ReturnType<typeof makeAuth>, login: string, email: string) {
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser({ name: login, email, emailVerified: true, login } as never);
  const account = (await ctx.internalAdapter.createAccount({
    userId: user.id, providerId: "github", accountId: "12345", accessToken: "gho_x",
  } as never)) as { id: string };
  return { ctx, user, account };
}

// Non-GitHub provider: no `login` on the user row, matching what a Google/Slack/X sign-in actually
// looks like (mapProfileToUser only exists for the github socialProviders entry). accessToken is
// set (fix pass 2, Task 3 Important) so the scope-write code path is genuinely reachable — without
// it, `expect(scopeRows).toEqual([])` below is vacuous, since the write is already gated on
// `account.accessToken` regardless of the providerId guard being tested.
async function createNonGithubUser(db: Awaited<ReturnType<typeof makeTestDb>>, auth: ReturnType<typeof makeAuth>, providerId: string, email: string) {
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser({ name: "Trinity", email, emailVerified: true } as never);
  const account = (await ctx.internalAdapter.createAccount({
    userId: user.id, providerId, accountId: "ext-999", accessToken: "tok_x",
  } as never)) as { id: string };
  return { ctx, user, account };
}

// GitHub provider but NO `login` on the user row (e.g. a profile row created before the GitHub
// profile sync completed). Pins the OTHER half of the guard (`!login`) independently of the
// providerId check: the anchor row is still written (unconditionally, login IS NULL), but org-scope
// capture must be skipped even though providerId === "github" and accessToken is set.
async function createGithubUserNoLogin(db: Awaited<ReturnType<typeof makeTestDb>>, auth: ReturnType<typeof makeAuth>, email: string) {
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser({ name: "Ghost", email, emailVerified: true } as never);
  const account = (await ctx.internalAdapter.createAccount({
    userId: user.id, providerId: "github", accountId: "gh-null-login", accessToken: "gho_z",
  } as never)) as { id: string };
  return { ctx, user, account };
}

describe("betterAuth over drizzle+PGlite — account hook integration (1a-Task 6)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("account.create.after fires on internalAdapter.createAccount: anchors accounts row + self scope", async () => {
    stubGithubMembershipsFetch();
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...opts });
    const { user } = await createGithubUser(db, auth, "neo", "neo@example.com");

    const anchorRows = (await db.execute(sql`select id, provider, login from accounts where id = ${user.id}`))
      .rows as { id: string; provider: string; login: string }[];
    expect(anchorRows).toHaveLength(1);
    expect(anchorRows[0]).toMatchObject({ provider: "github", login: "neo" });

    const scopeRows = (await db.execute(sql`select scope, role from account_scopes where account_id = ${user.id}`))
      .rows as { scope: string; role: string }[];
    // fetchOrgMemberships is stubbed to fail (fake token), so org memberships are empty by design —
    // the SELF scope proves setAccountScopes ran off the real hook, not a memory-adapter stand-in.
    expect(scopeRows).toEqual([{ scope: "neo", role: "self" }]);
  });

  it("account.update.after fires on internalAdapter.updateAccount: re-login re-captures scopes", async () => {
    stubGithubMembershipsFetch();
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...opts });
    const { user, account } = await createGithubUser(db, auth, "neo", "neo@example.com");
    const ctx = await auth.$context;

    // Wipe scopes so the assertion below can only pass if the UPDATE hook re-wrote them, not a
    // leftover from create.
    await db.execute(sql`delete from account_scopes where account_id = ${user.id}`);

    await ctx.internalAdapter.updateAccount(account.id, { accessToken: "gho_y" });

    const scopeRows = (await db.execute(sql`select scope, role from account_scopes where account_id = ${user.id}`))
      .rows as { scope: string; role: string }[];
    expect(scopeRows).toEqual([{ scope: "neo", role: "self" }]);
  });

  it("findAccountByProviderId links the existing github account — no duplicate user for a repeat sign-in", async () => {
    stubGithubMembershipsFetch();
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...opts });
    const { ctx, user } = await createGithubUser(db, auth, "neo", "neo@example.com");

    const linked = await ctx.internalAdapter.findAccountByProviderId("12345", "github");
    expect(linked?.userId).toBe(user.id);

    const userCount = (await db.execute(sql`select count(*)::int as n from "user"`)).rows?.[0] as { n: number };
    expect(userCount.n).toBe(1);
  });

  // Critical review fix (Task 3): the earlier anchorGeneralized.test.ts drove upsertAccount
  // directly and never exercised anchorAndScopes itself, so restoring the deleted
  // `if (account.providerId !== "github") return;` early-return wouldn't fail any test in the
  // repo. This one drives the real databaseHooks.account.create.after hook for a non-github
  // provider, pinning both halves of the generalization: the anchor row IS written (satisfying
  // the ten accounts.id FKs), and org-scope capture IS skipped (that stays GitHub-only).
  //
  // Fix pass 2 (Task 3 Important): this assertion was vacuous until createNonGithubUser set an
  // accessToken above — reaching the scope-write branch requires `account.accessToken`, so
  // `scopeRows` was `[]` regardless of the guard. Now that accessToken is set, this test genuinely
  // pins the `providerId !== "github"` disjunct: narrowing the guard to `if (!login) return;`
  // (dropping the provider check) makes this test fail.
  it("account.create.after anchors a non-github user with a NULL login and skips org-scope capture", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...opts });
    const { user } = await createNonGithubUser(db, auth, "google", "trinity-google@example.com");

    const anchorRows = (await db.execute(sql`select id, provider, login from accounts where id = ${user.id}`))
      .rows as { id: string; provider: string; login: string | null }[];
    expect(anchorRows).toHaveLength(1);
    expect(anchorRows[0].id).toBe(user.id);
    expect(anchorRows[0].login).toBeNull();

    const scopeRows = (await db.execute(sql`select scope, role from account_scopes where account_id = ${user.id}`))
      .rows as { scope: string; role: string }[];
    expect(scopeRows).toEqual([]);

    // One of the ten accounts.id FK tables — proves the anchor row actually satisfies the FK, so
    // this user's first star/review/group-create doesn't 500.
    await db.execute(sql`insert into stars (id, account_id, target_kind, target_id) values (${crypto.randomUUID()}, ${user.id}, 'gem', '@a/b')`);
    const starRows = (await db.execute(sql`select count(*)::int as n from stars where account_id = ${user.id}`))
      .rows as { n: number }[];
    expect(starRows[0].n).toBe(1);
  });

  // Fix pass 2 (Task 3 Important): pins the guard's OTHER disjunct (`!login`) independently of the
  // providerId check. A github account whose "user".login is NULL must still get an unconditional
  // anchor row, but org-scope capture must be skipped. Removing `|| !login` from the guard (leaving
  // just `if (account.providerId !== "github") return;`) makes this test fail.
  //
  // Asserting on `scopeRows` alone is NOT enough here: `account_scopes.scope` is NOT NULL
  // (schema.ts), so a buggy attempt to write `{ scope: null, ... }` throws inside setAccountScopes
  // and is swallowed by anchorAndScopes' own `catch` — `scopeRows` would stay `[]` for the WRONG
  // reason even with the guard removed. So this also spies on the network call fetchOrgMemberships
  // makes: the guard must skip org-scope capture BEFORE any network call is attempted.
  it("account.create.after anchors a github user with a NULL login and skips org-scope capture", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...opts });
    const { user } = await createGithubUserNoLogin(db, auth, "ghost@example.com");

    expect(fetchSpy).not.toHaveBeenCalled();

    const anchorRows = (await db.execute(sql`select id, provider, login from accounts where id = ${user.id}`))
      .rows as { id: string; provider: string; login: string | null }[];
    expect(anchorRows).toHaveLength(1);
    expect(anchorRows[0].id).toBe(user.id);
    expect(anchorRows[0].login).toBeNull();

    const scopeRows = (await db.execute(sql`select scope, role from account_scopes where account_id = ${user.id}`))
      .rows as { scope: string; role: string }[];
    expect(scopeRows).toEqual([]);
  });

  it("a minted session for the anchored user resolves via auth.api.getSession", async () => {
    stubGithubMembershipsFetch();
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...opts });
    const { user } = await createGithubUser(db, auth, "neo", "neo@example.com");

    const { token } = await mintSession(auth, user.id);
    const session = await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) });
    expect(session?.user?.id).toBe(user.id);
    expect((session?.user as { login?: string } | undefined)?.login).toBe("neo");
  });
});
