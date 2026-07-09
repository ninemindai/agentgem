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
