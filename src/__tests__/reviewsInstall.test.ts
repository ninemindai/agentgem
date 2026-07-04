// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { makeTestDb, upsertAccount, createSession, generateSessionToken, upsertReview } from "@agentgem/aggregator";
import { postHandler, deleteHandler, getHandler, summaryHandler } from "../reviews/install.js";
import { SESSION_COOKIE } from "../auth/cookie.js";

const webOrigins = ["https://app.agentgem.ai"];
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
const deps = (db: any) => ({ db, webOrigins });
const ID = "matt-skills/x.md";

async function withSession(db: any, id = "1", login = "u") {
  const a = await upsertAccount(db, { provider: "github", accountId: id, login });
  const { token } = generateSessionToken();
  await createSession(db, a.id, token, 60_000);
  return { a, token };
}

describe("reviews endpoints", () => {
  it("POST 401s without a session", async () => {
    const db = await makeTestDb();
    const res = mockRes();
    await postHandler(deps(db))(req({ method: "POST", body: { kind: "skill", id: ID, rating: 4 } }) as any, res as any);
    expect(res._status).toBe(401);
  });

  it("POST with a session writes and returns {mine, summary} + CORS", async () => {
    const db = await makeTestDb();
    const { token } = await withSession(db);
    const res = mockRes();
    await postHandler(deps(db))(req({ method: "POST", headers: { cookie: `${SESSION_COOKIE}=${token}`, origin: webOrigins[0] }, body: { kind: "skill", id: ID, rating: 4, body: "great" } }) as any, res as any);
    expect((res._body as any).mine.rating).toBe(4);
    expect((res._body as any).summary).toEqual({ avg: 4, count: 1 });
    expect(res._headers["access-control-allow-origin"]).toBe(webOrigins[0]);
    expect(res._headers["access-control-allow-credentials"]).toBe("true");
  });

  it("POST 400s on bad rating, bad kind, and over-long body", async () => {
    const db = await makeTestDb();
    const { token } = await withSession(db);
    const h = postHandler(deps(db));
    const cookie = `${SESSION_COOKIE}=${token}`;
    for (const bad of [
      { kind: "skill", id: ID, rating: 6 },
      { kind: "gem", id: ID, rating: 4 },            // gem not in reviews KINDS
      { kind: "skill", id: ID, rating: 4, body: "x".repeat(4001) },
      { kind: "skill", id: ID, rating: 2.5 },
    ]) {
      const res = mockRes();
      await h(req({ method: "POST", headers: { cookie }, body: bad }) as any, res as any);
      expect(res._status).toBe(400);
    }
  });

  it("GET returns summary + reviews always, and mine only with a cookie", async () => {
    const db = await makeTestDb();
    const { a, token } = await withSession(db);
    await upsertReview(db, a.id, "skill", ID, 5, "mine!");
    const anon = mockRes();
    await getHandler(deps(db))(req({ method: "GET", query: { kind: "skill", id: ID } }) as any, anon as any);
    expect((anon._body as any).summary).toEqual({ avg: 5, count: 1 });
    expect((anon._body as any).reviews).toHaveLength(1);
    expect((anon._body as any).mine).toBeNull();
    const mineRes = mockRes();
    await getHandler(deps(db))(req({ method: "GET", headers: { cookie: `${SESSION_COOKIE}=${token}` }, query: { kind: "skill", id: ID } }) as any, mineRes as any);
    expect((mineRes._body as any).mine.body).toBe("mine!");
  });

  it("DELETE removes the caller's review", async () => {
    const db = await makeTestDb();
    const { a, token } = await withSession(db);
    await upsertReview(db, a.id, "skill", ID, 3, null);
    const res = mockRes();
    await deleteHandler(deps(db))(req({ method: "DELETE", headers: { cookie: `${SESSION_COOKIE}=${token}` }, query: { kind: "skill", id: ID } }) as any, res as any);
    expect((res._body as any).summary).toEqual({ avg: 0, count: 0 });
  });

  it("GET /summary batches across ids", async () => {
    const db = await makeTestDb();
    const { a } = await withSession(db);
    await upsertReview(db, a.id, "skill", "s/a.md", 4, null);
    const res = mockRes();
    await summaryHandler(deps(db))(req({ method: "GET", query: { kind: "skill", ids: "s/a.md,s/b.md" } }) as any, res as any);
    expect((res._body as any).summaries["s/a.md"]).toEqual({ avg: 4, count: 1 });
    expect((res._body as any).summaries["s/b.md"]).toBeUndefined();
  });
});
