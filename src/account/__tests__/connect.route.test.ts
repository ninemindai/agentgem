// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { makeTestDb, makeAuth, resolveSession, stashConnectState, consumeConnectState, pendingLink } from "@agentgem/aggregator";
import type { AppDb } from "@agentgem/aggregator";
import { mintBetterAuthCookieForTest } from "@agentgem/aggregator/testing";
import { connectStartHandler, connectCallbackShim, type ConnectDeps, type IdentityResolver } from "../connect.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const webOrigins = ["https://app.agentgem.ai"];
const publicBase = "https://app.agentgem.ai";
const authOpts = {
  secret: "test-secret", baseURL: "http://localhost:4000/api/auth",
  githubClientId: "gid", githubClientSecret: "gsecret",
  googleClientId: "goid", googleClientSecret: "gosecret",
  webOrigins,
};

function res() {
  const r: any = { code: 200, body: undefined as unknown, redirected: undefined as string | undefined };
  r.status = (c: number) => { r.code = c; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  r.redirect = (c: number, url: string) => { r.code = c; r.redirected = url; return r; };
  return r;
}
const req = (over: Record<string, unknown> = {}) =>
  ({ method: "GET", params: {}, query: {}, headers: {}, ...over }) as any;

const deps = (db: AppDb, auth: ReturnType<typeof makeAuth>, over: Partial<ConnectDeps> = {}): ConnectDeps =>
  ({ db, auth, webOrigins, publicBase, ...over });

async function seedUser(auth: ReturnType<typeof makeAuth>, email: string): Promise<string> {
  const ctx = await auth.$context;
  const u = await ctx.internalAdapter.createUser({ email, name: email, emailVerified: false } as never);
  return u.id;
}

describe("connect flow", () => {
  it("start: 401 without a session", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const r = res();
    await connectStartHandler(deps(db, auth))(req({ params: { provider: "github" } }), r);
    expect(r.code).toBe(401);
  });

  it("start: with a session stores a connect_state and 302s to the provider", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const cookie = await mintBetterAuthCookieForTest(db, authOpts);
    const who = await resolveSession(auth, { cookie });
    if (!who) throw new Error("test setup: cookie did not resolve to a session");

    const r = res();
    await connectStartHandler(deps(db, auth))(req({ params: { provider: "github" }, headers: { cookie } }), r);

    expect(r.code).toBe(302);
    expect(r.redirected).toContain("https://github.com/login/oauth/authorize");
    // the raw state rides the redirect URL; the store holds only its hash, bound to the caller.
    const state = new URL(r.redirected!).searchParams.get("state");
    expect(state).toBeTruthy();
    const row = await consumeConnectState(db, sha256(state!));
    expect(row?.currentUserId).toBe(who.accountId);
    expect(row?.provider).toBe("github");
  });

  it("start: twitter (X) is an allowed provider and 302s to x.com's authorize endpoint when configured", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts, twitterClientId: "xid", twitterClientSecret: "xsec" });
    const cookie = await mintBetterAuthCookieForTest(db, authOpts);
    const who = await resolveSession(auth, { cookie });
    if (!who) throw new Error("test setup: cookie did not resolve to a session");

    const r = res();
    await connectStartHandler(deps(db, auth))(req({ params: { provider: "twitter" }, headers: { cookie } }), r);

    expect(r.code).toBe(302);
    expect(r.redirected).toContain("https://x.com/i/oauth2/authorize");
    const state = new URL(r.redirected!).searchParams.get("state");
    expect(state).toBeTruthy();
    const row = await consumeConnectState(db, sha256(state!));
    expect(row?.currentUserId).toBe(who.accountId);
    expect(row?.provider).toBe("twitter");
  });

  it("callback shim: OUR state -> resolves identity, stashPendingLink, 302 /account?connect=ready", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const u1 = await seedUser(auth, "u1@x.com");
    const u2 = await seedUser(auth, "u2@x.com");
    // an `account` row so accountIdForProvider('google','g-other') resolves to the OTHER user.
    await db.execute(sql`insert into account (id, user_id, account_id, provider_id, created_at, updated_at)
      values (gen_random_uuid()::text, ${u2}, 'g-other', 'google', now(), now())`);
    await stashConnectState(db, { stateHash: sha256("s"), codeVerifier: "v", currentUserId: u1, provider: "google" });

    const fakeResolve: IdentityResolver = async () => ({ providerId: "google", providerAccountId: "g-other" });
    const r = res();
    await connectCallbackShim(deps(db, auth, { resolveIdentity: fakeResolve }))(
      req({ params: { provider: "google" }, query: { code: "c", state: "s" } }), r, () => { throw new Error("next() must not be called for our state"); },
    );

    expect(r.code).toBe(302);
    expect(r.redirected).toBe(`${publicBase}/account?connect=ready`);
    expect(await pendingLink(db, u1)).toEqual({ providerId: "google", providerAccountId: "g-other" });
  });

  it("callback shim: a FOREIGN state calls next() and does not touch pending links", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const u1 = await seedUser(auth, "u1@x.com");
    let nexted = false;
    const mustNotResolve: IdentityResolver = async () => { throw new Error("resolveIdentity must not run for a foreign state"); };
    const r = res();
    await connectCallbackShim(deps(db, auth, { resolveIdentity: mustNotResolve }))(
      req({ params: { provider: "github" }, query: { code: "c", state: "x" } }), r, () => { nexted = true; },
    );

    expect(nexted).toBe(true);
    expect(r.redirected).toBeUndefined();
    expect(await pendingLink(db, u1)).toBeNull();
  });
});
