// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, makeAuth, resolveSession, stashPendingLink, pendingLink, upsertAccount } from "@agentgem/aggregator";
import type { AppDb } from "@agentgem/aggregator";
// Test-only helper — not re-exported from the main barrel (see index.ts), imported via the
// package's "testing" subpath instead (mirrors providers.route.test.ts).
import { mintBetterAuthCookieForTest } from "@agentgem/aggregator/testing";
import { absorbHandler } from "../install.js";

const webOrigins = ["https://app.agentgem.ai"];
const authOpts = {
  secret: "test-secret", baseURL: "http://localhost:4000",
  githubClientId: "gid", githubClientSecret: "gsecret",
  googleClientId: "goid", googleClientSecret: "gosecret",
  webOrigins,
};
const deps = (db: AppDb, auth: ReturnType<typeof makeAuth>) => ({ db, auth, webOrigins });

function res() {
  const r: any = { code: 200, body: undefined as unknown, headers: {} as Record<string, string> };
  r.status = (c: number) => { r.code = c; return r; };
  r.set = (k: string, v: string) => { r.headers[k] = v; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  r.send = (b: unknown) => { r.body = b; return r; };
  return r;
}
const req = (over: Record<string, unknown> = {}) => ({ method: "POST", path: "/api/account/absorb", query: {}, body: {}, headers: {}, ...over }) as any;

/** Insert a better-auth `account` row so `accountIdForProvider` resolves it to `userId`. */
async function linkProvider(db: AppDb, userId: string, providerId: string, providerAccountId: string): Promise<void> {
  await db.execute(sql`insert into account (id, user_id, account_id, provider_id, created_at, updated_at) values
    (gen_random_uuid()::text, ${userId}, ${providerAccountId}, ${providerId}, now(), now())`);
}

async function claimHandle(db: AppDb, userId: string, handle: string): Promise<void> {
  await db.execute(sql`update "user" set handle = ${handle} where id = ${userId}`);
}

describe("POST /api/account/absorb", () => {
  it("401 without a session; 409 when there is no pending link", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });

    const r1 = res();
    await absorbHandler(deps(db, auth))(req(), r1);
    expect(r1.code).toBe(401);

    const cookie = await mintBetterAuthCookieForTest(db, authOpts);
    const r2 = res();
    await absorbHandler(deps(db, auth))(req({ headers: { cookie } }), r2);
    expect(r2.code).toBe(409);
  });

  it("absorbs a fresh other account; survivor has both providers; pending row consumed", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const cookie = await mintBetterAuthCookieForTest(db, authOpts);
    const who = await resolveSession(auth, { cookie });
    if (!who) throw new Error("test setup: cookie did not resolve to a session");
    await claimHandle(db, who.accountId, "curhandle"); // current is data-bearing (survivor)

    // Fresh other account owns the OAuth'd google identity the connect callback (Task 2) stashed.
    const ctx = await auth.$context;
    const other = await ctx.internalAdapter.createUser({ email: "other@x.com", name: "Other", emailVerified: false } as never);
    await upsertAccount(db, { provider: "google", accountId: "g-other", login: null, avatarUrl: null, id: other.id });
    await linkProvider(db, other.id, "google", "g-other");

    await stashPendingLink(db, who.accountId, { providerId: "google", providerAccountId: "g-other" });

    const r = res();
    await absorbHandler(deps(db, auth))(req({ headers: { cookie } }), r);
    expect(r.code).toBe(200);
    expect(r.body).toEqual({ keep: who.accountId, connected: ["credential", "google"] });
    expect(r.headers["Set-Cookie"]).toBeUndefined(); // caller keeps its own session — no re-mint needed
    expect(await pendingLink(db, who.accountId)).toBeNull();
    expect((await db.execute(sql`select 1 from "user" where id = ${other.id}`)).rows).toHaveLength(0); // dropped
  });

  it("re-mints the session when the caller's own fresh account is dropped", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const cookie = await mintBetterAuthCookieForTest(db, authOpts);
    const who = await resolveSession(auth, { cookie });
    if (!who) throw new Error("test setup: cookie did not resolve to a session");
    // `who` stays fresh — the email/password signup's own "credential" account row is not a
    // freshness blocker (accountFreshness only checks data tables, not connected-provider count).

    // Data-bearing other account owns the OAuth'd provider.
    const ctx = await auth.$context;
    const other = await ctx.internalAdapter.createUser({ email: "other2@x.com", name: "Other2", emailVerified: false } as never);
    await upsertAccount(db, { provider: "google", accountId: "g-other2", login: null, avatarUrl: null, id: other.id });
    await linkProvider(db, other.id, "google", "g-other2");
    await claimHandle(db, other.id, "otherhandle"); // data-bearing survivor

    await stashPendingLink(db, who.accountId, { providerId: "google", providerAccountId: "g-other2" });

    const r = res();
    await absorbHandler(deps(db, auth))(req({ headers: { cookie } }), r);
    expect(r.code).toBe(200);
    expect(r.body).toMatchObject({ keep: other.id });
    expect(r.headers["Set-Cookie"]).toBeTruthy();
    expect(await pendingLink(db, who.accountId)).toBeNull();
    expect((await db.execute(sql`select 1 from "user" where id = ${who.accountId}`)).rows).toHaveLength(0); // caller dropped
  });

  it("409 merge-not-supported when neither account is fresh", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const cookie = await mintBetterAuthCookieForTest(db, authOpts);
    const who = await resolveSession(auth, { cookie });
    if (!who) throw new Error("test setup: cookie did not resolve to a session");
    await claimHandle(db, who.accountId, "bothcur"); // current is data-bearing

    const ctx = await auth.$context;
    const other = await ctx.internalAdapter.createUser({ email: "other3@x.com", name: "Other3", emailVerified: false } as never);
    await upsertAccount(db, { provider: "google", accountId: "g-other3", login: null, avatarUrl: null, id: other.id });
    await linkProvider(db, other.id, "google", "g-other3");
    await claimHandle(db, other.id, "bothother"); // other is ALSO data-bearing

    await stashPendingLink(db, who.accountId, { providerId: "google", providerAccountId: "g-other3" });

    const r = res();
    await absorbHandler(deps(db, auth))(req({ headers: { cookie } }), r);
    expect(r.code).toBe(409);
    expect(r.headers["Set-Cookie"]).toBeUndefined();
    // nothing consumed — merge was refused, not attempted.
    expect(await pendingLink(db, who.accountId)).not.toBeNull();
    expect((await db.execute(sql`select 1 from "user" where id = ${other.id}`)).rows).toHaveLength(1);
  });
});
