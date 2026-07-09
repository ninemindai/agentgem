// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// 1b-Task 4: the SSO handoff redeem's cookie-emission mechanism. mintSessionCookie must hand back a
// GENUINE better-auth Set-Cookie — proven here by feeding it straight back into resolveSession,
// exactly like webAuthShim.test.ts proves for mintBetterAuthCookieForTest's sign-up-driven cookie.
// A hand-forged cookie would fail this same assertion (wrong HMAC signature).
import { describe, it, expect } from "vitest";
import { makeTestDb, makeAuth, mintSessionCookie, resolveSession } from "@agentgem/aggregator";

const opts = {
  secret: "test-secret",
  baseURL: "http://localhost:4000",
  githubClientId: "gid",
  githubClientSecret: "gsecret",
  webOrigins: ["http://localhost:3000"],
};

describe("mintSessionCookie", () => {
  it("mints a genuine better-auth session cookie resolveSession accepts", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...opts });
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser({
      name: "Trinity", email: "trinity@example.com", emailVerified: true, login: "trinity",
    } as never);

    const cookie = await mintSessionCookie(auth, user.id);
    expect(cookie).toContain("session_token");
    expect(cookie).toContain("HttpOnly");

    const who = await resolveSession(auth, { cookie });
    expect(who).toEqual({ login: "trinity", avatarUrl: null, accountId: user.id });
  });

  it("mints an independently usable cookie each call (no cross-call leakage)", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...opts });
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser({
      name: "Neo", email: "neo@example.com", emailVerified: true, login: "neo",
    } as never);

    const cookieA = await mintSessionCookie(auth, user.id);
    const cookieB = await mintSessionCookie(auth, user.id);
    expect(cookieA).not.toBe(cookieB);
    expect((await resolveSession(auth, { cookie: cookieA }))?.login).toBe("neo");
    expect((await resolveSession(auth, { cookie: cookieB }))?.login).toBe("neo");
  });
});
