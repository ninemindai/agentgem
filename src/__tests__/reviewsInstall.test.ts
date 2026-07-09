// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { makeTestDb, makeAuth, mintSession, upsertReview } from "@agentgem/aggregator";
import { postHandler, deleteHandler, getHandler, summaryHandler } from "../reviews/install.js";

const webOrigins = ["https://app.agentgem.ai"];
const authOpts = {
  secret: "test-secret", baseURL: "http://localhost:4000",
  githubClientId: "gid", githubClientSecret: "gsecret",
  webOrigins,
};
function mockRes() {
  const r: any = { _status: 200, _headers: {} as Record<string, string>, _body: undefined };
  r.status = (c: number) => { r._status = c; return r; };
  r.set = (k: string, v: string) => { r._headers[k.toLowerCase()] = v; return r; };
  r.setHeader = (k: string, v: string) => { r._headers[k.toLowerCase()] = v; return r; };
  r.json = (b: unknown) => { r._body = b; return r; };
  r.send = (b: unknown) => { r._body = b; return r; };
  return r;
}
const req = (over: any = {}) => ({ method: "GET", path: "/", query: {}, body: {}, headers: {}, get(n: string) { return (this.headers as any)[n.toLowerCase()]; }, ...over });
const deps = (db: any, auth: any) => ({ db, auth, webOrigins });
const ID = "matt-skills/x.md";

// Better-auth user + accounts anchor (via the account.create hook) + a minted bearer session,
// replacing the old createSession/generateSessionToken pair (Plan 1b cutover).
async function withSession(db: any, auth: any, id = "1", login = "u") {
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser({ name: login, email: `${login}@example.com`, emailVerified: true, login } as never);
  await ctx.internalAdapter.createAccount({ userId: user.id, providerId: "github", accountId: id } as never);
  const { token } = await mintSession(auth, user.id);
  return { a: { id: user.id }, token };
}

describe("reviews endpoints", () => {
  it("POST 401s without a session", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const res = mockRes();
    await postHandler(deps(db, auth))(req({ method: "POST", body: { kind: "skill", id: ID, rating: 4 } }) as any, res as any);
    expect(res._status).toBe(401);
  });

  it("POST with a session writes and returns {mine, summary} + CORS", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const { token } = await withSession(db, auth);
    const res = mockRes();
    await postHandler(deps(db, auth))(req({ method: "POST", headers: { authorization: `Bearer ${token}`, origin: webOrigins[0] }, body: { kind: "skill", id: ID, rating: 4, body: "great" } }) as any, res as any);
    expect((res._body as any).mine.rating).toBe(4);
    expect((res._body as any).summary).toEqual({ avg: 4, count: 1 });
    expect(res._headers["access-control-allow-origin"]).toBe(webOrigins[0]);
    expect(res._headers["access-control-allow-credentials"]).toBe("true");
  });

  it("POST 400s on bad rating, bad kind, and over-long body", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const { token } = await withSession(db, auth);
    const h = postHandler(deps(db, auth));
    const headers = { authorization: `Bearer ${token}` };
    for (const bad of [
      { kind: "skill", id: ID, rating: 6 },
      { kind: "gem", id: ID, rating: 4 },            // gem not in reviews KINDS
      { kind: "skill", id: ID, rating: 4, body: "x".repeat(4001) },
      { kind: "skill", id: ID, rating: 2.5 },
    ]) {
      const res = mockRes();
      await h(req({ method: "POST", headers, body: bad }) as any, res as any);
      expect(res._status).toBe(400);
    }
  });

  it("GET returns summary + reviews always, and mine only when signed in", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const { a, token } = await withSession(db, auth);
    await upsertReview(db, a.id, "skill", ID, 5, "mine!");
    const anon = mockRes();
    await getHandler(deps(db, auth))(req({ method: "GET", query: { kind: "skill", id: ID } }) as any, anon as any);
    expect((anon._body as any).summary).toEqual({ avg: 5, count: 1 });
    expect((anon._body as any).reviews).toHaveLength(1);
    expect((anon._body as any).mine).toBeNull();
    const mineRes = mockRes();
    await getHandler(deps(db, auth))(req({ method: "GET", headers: { authorization: `Bearer ${token}` }, query: { kind: "skill", id: ID } }) as any, mineRes as any);
    expect((mineRes._body as any).mine.body).toBe("mine!");
  });

  it("DELETE removes the caller's review", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const { a, token } = await withSession(db, auth);
    await upsertReview(db, a.id, "skill", ID, 3, null);
    const res = mockRes();
    await deleteHandler(deps(db, auth))(req({ method: "DELETE", headers: { authorization: `Bearer ${token}` }, query: { kind: "skill", id: ID } }) as any, res as any);
    expect((res._body as any).summary).toEqual({ avg: 0, count: 0 });
  });

  it("GET /summary batches across ids", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const { a } = await withSession(db, auth);
    await upsertReview(db, a.id, "skill", "s/a.md", 4, null);
    const res = mockRes();
    await summaryHandler(deps(db, auth))(req({ method: "GET", query: { kind: "skill", ids: "s/a.md,s/b.md" } }) as any, res as any);
    expect((res._body as any).summaries["s/a.md"]).toEqual({ avg: 4, count: 1 });
    expect((res._body as any).summaries["s/b.md"]).toBeUndefined();
  });
});
