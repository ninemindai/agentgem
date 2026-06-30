// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { makeTestDb, upsertAccount, createSession, generateSessionToken, toggleStar } from "@agentgem/aggregator";
import { toggleHandler, listHandler } from "../stars/install.js";
import { SESSION_COOKIE } from "../auth/cookie.js";

const webOrigins = ["https://app.agentgem.ai"];
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
const deps = (db: any) => ({ db, webOrigins });

async function withSession(db: any) {
  const a = await upsertAccount(db, { provider: "github", accountId: "1", login: "u" });
  const { token } = generateSessionToken();
  await createSession(db, a.id, token, 60_000);
  return { a, token };
}

describe("stars endpoints", () => {
  it("POST toggle 401s without a session", async () => {
    const db = await makeTestDb();
    const res = mockRes();
    await toggleHandler(deps(db))(req({ method: "POST", body: { kind: "gem", id: "x" } }) as any, res as any);
    expect(res._status).toBe(401);
  });

  it("POST toggle with a session stars + returns {starred,count}", async () => {
    const db = await makeTestDb();
    const { token } = await withSession(db);
    const res = mockRes();
    await toggleHandler(deps(db))(req({ method: "POST", headers: { cookie: `${SESSION_COOKIE}=${token}`, origin: webOrigins[0] }, body: { kind: "gem", id: "x" } }) as any, res as any);
    expect(res._body).toEqual({ starred: true, count: 1 });
    expect(res._headers["access-control-allow-origin"]).toBe(webOrigins[0]);
    expect(res._headers["access-control-allow-credentials"]).toBe("true");
  });

  it("POST toggle 400s on a bad kind", async () => {
    const db = await makeTestDb();
    const { token } = await withSession(db);
    const res = mockRes();
    await toggleHandler(deps(db))(req({ method: "POST", headers: { cookie: `${SESSION_COOKIE}=${token}` }, body: { kind: "nope", id: "x" } }) as any, res as any);
    expect(res._status).toBe(400);
  });

  it("GET returns public counts always, and mine only with a cookie", async () => {
    const db = await makeTestDb();
    const { a, token } = await withSession(db);
    await toggleStar(db, a.id, "gem", "x");
    // anonymous: counts but no mine
    const anon = mockRes();
    await listHandler(deps(db))(req({ method: "GET", query: { kind: "gem", ids: "x,y" } }) as any, anon as any);
    expect((anon._body as any).counts.x).toBe(1);
    expect((anon._body as any).mine).toEqual([]);
    // with cookie: mine populated
    const mineRes = mockRes();
    await listHandler(deps(db))(req({ method: "GET", headers: { cookie: `${SESSION_COOKIE}=${token}` }, query: { kind: "gem", ids: "x,y" } }) as any, mineRes as any);
    expect((mineRes._body as any).mine).toEqual(["x"]);
  });
});
