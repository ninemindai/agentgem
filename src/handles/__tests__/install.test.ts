// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, makeAuth, resolveSession } from "@agentgem/aggregator";
import type { AppDb } from "@agentgem/aggregator";
// Test-only helper — not re-exported from the main barrel (see index.ts), imported via the
// package's "testing" subpath instead.
import { mintBetterAuthCookieForTest } from "@agentgem/aggregator/testing";
import { claimHandler } from "../install.js";

const webOrigins = ["https://app.agentgem.ai"];
const authOpts = {
  secret: "test-secret", baseURL: "http://localhost:4000",
  githubClientId: "gid", githubClientSecret: "gsecret",
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
const req = (over: Record<string, unknown> = {}) => ({ method: "POST", path: "/api/handle", query: {}, body: {}, headers: {}, ...over }) as any;

// Mints a REAL better-auth session cookie (see webAuthShim.test.ts's cookie-path regression guard)
// for a fresh account, and resolves it back to the accountId the route will see — this is the same
// uuid `claimHandle` writes against and that "user".id / accounts.id share by construction.
//
// mintBetterAuthCookieForTest signs up through its OWN throwaway better-auth instance, which does
// NOT run makeAuth's `databaseHooks.account.create` (that hook lives on the production `auth`
// instance under test, and hooks are per-instance) — so it only ever inserts a "user" row, never
// the legacy `accounts` anchor. claimHandle's setAccountScopes writes account_scopes, which FKs to
// accounts.id, so the anchor is inserted here directly, same id as "user" (accounts.id === "user".id
// by construction — see handles.ts).
async function signedIn(db: AppDb, auth: ReturnType<typeof makeAuth>) {
  const cookie = await mintBetterAuthCookieForTest(db, authOpts);
  const who = await resolveSession(auth, { cookie });
  if (!who) throw new Error("test setup: cookie did not resolve to a session");
  await db.execute(sql`insert into accounts (id, provider, provider_account_id) values (${who.accountId}, 'test', ${who.accountId})`);
  return { cookie, accountId: who.accountId };
}

describe("POST /api/handle", () => {
  it("401 without a session", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const r = res();
    await claimHandler(deps(db, auth))(req({ body: { handle: "raymond" } }), r);
    expect(r.code).toBe(401);
  });

  it("200 and persists on a free handle", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const { cookie, accountId } = await signedIn(db, auth);
    const r = res();
    await claimHandler(deps(db, auth))(req({ headers: { cookie }, body: { handle: "raymond" } }), r);
    expect(r.code).toBe(200);
    expect(r.body).toEqual({ handle: "raymond" });
    const q = await db.execute(sql`select handle from "user" where id = ${accountId}`);
    expect((q.rows as { handle: string }[])[0].handle).toBe("raymond");
  });

  it("400 on charset, 409 on taken, 409 on a reserved org name", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const { cookie } = await signedIn(db, auth);

    const charset = res();
    await claimHandler(deps(db, auth))(req({ headers: { cookie }, body: { handle: "has space" } }), charset);
    expect(charset.code).toBe(400);

    await db.execute(sql`insert into "user" (id, email, email_verified, handle) values (gen_random_uuid()::text, 'o@e.com', false, 'taken')`);
    const taken = res();
    await claimHandler(deps(db, auth))(req({ headers: { cookie }, body: { handle: "taken" } }), taken);
    expect(taken.code).toBe(409);

    await db.execute(sql`insert into org_members (org_scope, gh_login, role) values ('ninemindai', 's', 'member')`);
    const reserved = res();
    await claimHandler(deps(db, auth))(req({ headers: { cookie }, body: { handle: "ninemindai" } }), reserved);
    expect(reserved.code).toBe(409);

    // "taken" and "reserved" must be indistinguishable — same status, same body.
    expect(reserved.code).toBe(taken.code);
    expect(reserved.body).toEqual(taken.body);
  });

  it("400 when the body carries no handle string", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const { cookie } = await signedIn(db, auth);
    const r = res();
    await claimHandler(deps(db, auth))(req({ headers: { cookie }, body: {} }), r);
    expect(r.code).toBe(400);
  });

  it("OPTIONS from a foreign origin sets no ACAO header", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const r = res();
    await claimHandler(deps(db, auth))(req({ method: "OPTIONS", headers: { origin: "https://evil.example" } }), r);
    expect(r.headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });
});
