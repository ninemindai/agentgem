// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { makeTestDb, makeAuth, mintSession, toggleStar } from "@agentgem/aggregator";
import { toggleHandler, listHandler } from "../stars/install.js";

const webOrigins = ["https://app.agentgem.ai"];
const authOpts = {
  secret: "test-secret", baseURL: "http://localhost:4000",
  githubClientId: "gid", githubClientSecret: "gsecret",
  webOrigins,
};
function mockRes() {
  const r: any = { _status: 200, _headers: {} as Record<string,string>, _body: undefined };
  r.status = (c: number) => { r._status = c; return r; };
  r.set = (k: string, v: string) => { r._headers[k.toLowerCase()] = v; return r; };
  r.setHeader = (k: string, v: string) => { r._headers[k.toLowerCase()] = v; return r; };
  r.json = (b: unknown) => { r._body = b; return r; };
  r.send = (b: unknown) => { r._body = b; return r; };
  return r;
}
const req = (over: any = {}) => ({ method: "GET", path: "/", query: {}, body: {}, headers: {}, get(n: string){ return (this.headers as any)[n.toLowerCase()]; }, ...over });
const deps = (db: any, auth: any) => ({ db, auth, webOrigins });

// Better-auth user + accounts anchor (via the account.create hook) + a minted bearer session,
// replacing the old createSession/generateSessionToken pair (Plan 1b cutover).
async function withSession(db: any, auth: any) {
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser({ name: "u", email: "u@example.com", emailVerified: true, login: "u" } as never);
  await ctx.internalAdapter.createAccount({ userId: user.id, providerId: "github", accountId: "1" } as never);
  const { token } = await mintSession(auth, user.id);
  return { a: { id: user.id }, token };
}

describe("stars endpoints", () => {
  it("POST toggle 401s without a session", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const res = mockRes();
    await toggleHandler(deps(db, auth))(req({ method: "POST", body: { kind: "gem", id: "x" } }) as any, res as any);
    expect(res._status).toBe(401);
  });

  it("POST toggle with a session stars + returns {starred,count}", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const { token } = await withSession(db, auth);
    const res = mockRes();
    await toggleHandler(deps(db, auth))(req({ method: "POST", headers: { authorization: `Bearer ${token}`, origin: webOrigins[0] }, body: { kind: "gem", id: "x" } }) as any, res as any);
    expect(res._body).toEqual({ starred: true, count: 1 });
    expect(res._headers["access-control-allow-origin"]).toBe(webOrigins[0]);
    expect(res._headers["access-control-allow-credentials"]).toBe("true");
  });

  it("POST toggle 400s on a bad kind", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const { token } = await withSession(db, auth);
    const res = mockRes();
    await toggleHandler(deps(db, auth))(req({ method: "POST", headers: { authorization: `Bearer ${token}` }, body: { kind: "nope", id: "x" } }) as any, res as any);
    expect(res._status).toBe(400);
  });

  it("GET returns public counts always, and mine only when signed in", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const { a, token } = await withSession(db, auth);
    await toggleStar(db, a.id, "gem", "x");
    // anonymous: counts but no mine
    const anon = mockRes();
    await listHandler(deps(db, auth))(req({ method: "GET", query: { kind: "gem", ids: "x,y" } }) as any, anon as any);
    expect((anon._body as any).counts.x).toBe(1);
    expect((anon._body as any).mine).toEqual([]);
    // signed in: mine populated
    const mineRes = mockRes();
    await listHandler(deps(db, auth))(req({ method: "GET", headers: { authorization: `Bearer ${token}` }, query: { kind: "gem", ids: "x,y" } }) as any, mineRes as any);
    expect((mineRes._body as any).mine).toEqual(["x"]);
  });
});
