// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Plan 1b-Task 1: resolveSession(auth, headers) is now a thin shim over better-auth's own
// auth.api.getSession — the whole point is that it must resolve a session no matter HOW better-auth
// itself chose to carry it (Bearer header today, its own signed cookie for the web). The old
// resolveSession(db, token) hardcoded the `ag_session` cookie NAME; better-auth's cookie is named
// differently, so a naive port would 401 every web (cookie-based) request. That regression is
// covered explicitly below with a REAL better-auth cookie, not a hand-rolled one.
import { describe, it, expect } from "vitest";
import { makeTestDb, makeAuth, mintSession, resolveSession, mintBetterAuthCookieForTest } from "@agentgem/aggregator";
import type { AppDb } from "@agentgem/aggregator";

const authOpts = {
  secret: "test-secret",
  baseURL: "http://localhost:4000",
  githubClientId: "gid",
  githubClientSecret: "gsecret",
  webOrigins: ["http://localhost:3000"],
};

async function githubUser(auth: ReturnType<typeof makeAuth>, login: string) {
  const ctx = await auth.$context;
  return ctx.internalAdapter.createUser({ name: login, email: `${login}@example.com`, emailVerified: true, login } as never);
}

describe("resolveSession (Plan 1b shim over better-auth)", () => {
  it("resolves a session presented as a Bearer header", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const user = await githubUser(auth, "trinity");
    const { token } = await mintSession(auth, user.id);

    const who = await resolveSession(auth, { authorization: `Bearer ${token}` });
    expect(who).toEqual({ login: "trinity", avatarUrl: null, accountId: user.id });
  });

  it("returns null for an unknown/garbage bearer token", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    expect(await resolveSession(auth, { authorization: "Bearer not-a-real-token" })).toBeNull();
    expect(await resolveSession(auth, {})).toBeNull();
  });

  it("accepts a Headers instance directly, not just a plain header record", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const user = await githubUser(auth, "neo");
    const { token } = await mintSession(auth, user.id);
    const who = await resolveSession(auth, new Headers({ authorization: `Bearer ${token}` }));
    expect(who?.login).toBe("neo");
  });

  // THE REGRESSION GUARD (review fix 3A): a session presented as a better-auth COOKIE — not a
  // Bearer header — must also resolve. This is exactly the bug the headers-based seam replaces:
  // the old code looked for a cookie literally named `ag_session` and would 401 every cookie-
  // carrying web request once better-auth (which names its cookie differently) went live.
  //
  // mintBetterAuthCookieForTest drives a REAL better-auth sign-up (on a throwaway instance sharing
  // this test's db + secret + baseURL) to obtain the cookie, rather than hand-rolling a signed
  // value — better-auth signs session cookies with an HMAC scheme private to its own dependency
  // (better-call), so fabricating one would mean silently depending on undocumented internals.
  // Driving the real endpoint proves resolveSession accepts whatever cookie better-auth issues,
  // under the SAME db + secret the production instance uses to verify it.
  it("resolves a session presented as a better-auth COOKIE (not Bearer) — the exact cutover regression", async () => {
    const db: AppDb = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts }); // the production-shaped instance under test

    const cookie = await mintBetterAuthCookieForTest(db, authOpts);

    const who = await resolveSession(auth, { cookie });
    expect(who).not.toBeNull();
    expect(who!.accountId).toBeTruthy();
  });
});
