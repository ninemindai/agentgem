// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, makeAuth, resolveSession } from "@agentgem/aggregator";
import type { AppDb } from "@agentgem/aggregator";
// Test-only helper — not re-exported from the main barrel (see index.ts), imported via the
// package's "testing" subpath instead (mirrors handles/__tests__/install.test.ts).
import { mintBetterAuthCookieForTest } from "@agentgem/aggregator/testing";
import { providersHandler } from "../install.js";

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
const req = (over: Record<string, unknown> = {}) => ({ method: "GET", path: "/api/account/providers", query: {}, body: {}, headers: {}, ...over }) as any;

describe("GET /api/account/providers", () => {
  it("401 without a session", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const r = res();
    await providersHandler(deps(db, auth))(req(), r);
    expect(r.code).toBe(401);
  });

  it("lists the connected providers for the signed-in account", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const cookie = await mintBetterAuthCookieForTest(db, authOpts);
    const who = await resolveSession(auth, { cookie });
    if (!who) throw new Error("test setup: cookie did not resolve to a session");
    // mintBetterAuthCookieForTest signs up via email/password, which already inserts a "credential"
    // provider row (see accountLinking.test.ts's connectedProviders test for the same pattern) —
    // link github+google on top of it and assert the full, sorted set.
    await db.execute(sql`insert into account (id, user_id, account_id, provider_id, created_at, updated_at) values
      (gen_random_uuid()::text, ${who.accountId}, 'gh', 'github', now(), now()),
      (gen_random_uuid()::text, ${who.accountId}, 'go', 'google', now(), now())`);

    const r = res();
    await providersHandler(deps(db, auth))(req({ headers: { cookie } }), r);
    expect(r.code).toBe(200);
    expect(r.body).toEqual({ connected: ["credential", "github", "google"] });
  });

  it("OPTIONS from a foreign origin sets no ACAO header", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const r = res();
    await providersHandler(deps(db, auth))(req({ method: "OPTIONS", headers: { origin: "https://evil.example" } }), r);
    expect(r.headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });
});
