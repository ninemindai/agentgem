// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import {
  makeTestDb, upsertAccount, createSession, generateSessionToken, setAccountScopes,
  normalizeUsageReport, recordUsageDays, buildOrgUsage, rangeCutoff,
} from "@agentgem/aggregator";
import { reportHandler, orgUsageHandler } from "../usage/install.js";
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

async function member(db: any, login: string, scopes: string[]) {
  const a = await upsertAccount(db, { provider: "github", accountId: login, login });
  await setAccountScopes(db, a.id, [login, ...scopes]);
  const { token } = generateSessionToken();
  await createSession(db, a.id, token, 60_000);
  return { a, token };
}

const day = (date: string, over: Partial<Record<string, number>> = {}) => ({ date, sessions: 2, msgs: 10, tokensIn: 100, tokensOut: 50, tokensCache: 1000, activeMs: 3_600_000, ...over });

describe("normalizeUsageReport", () => {
  it("accepts a valid batch and defaults machine", () => {
    const r = normalizeUsageReport({ days: [day("2026-07-01")] });
    expect(r?.machine).toBe("default");
    expect(r?.days[0]).toMatchObject({ date: "2026-07-01", sessions: 2, tokensCache: 1000 });
  });
  it("rejects a missing/empty/oversized days array", () => {
    expect(normalizeUsageReport({})).toBeNull();
    expect(normalizeUsageReport({ days: [] })).toBeNull();
    expect(normalizeUsageReport({ days: Array.from({ length: 401 }, () => day("2026-01-01")) })).toBeNull();
  });
  it("rejects malformed dates and clamps garbage numbers", () => {
    expect(normalizeUsageReport({ days: [day("07/01/2026")] })).toBeNull();
    const r = normalizeUsageReport({ days: [day("2026-07-01", { sessions: -5, tokensIn: Number.NaN })] });
    expect(r?.days[0].sessions).toBe(0);
    expect(r?.days[0].tokensIn).toBe(0);
  });
});

describe("recordUsageDays + buildOrgUsage", () => {
  it("upserts per (account,machine,date) — a re-report overwrites, machines add up", async () => {
    const db = await makeTestDb();
    const { a } = await member(db, "alice", ["acme"]);
    await recordUsageDays(db, a.id, "laptop", [day("2026-07-01", { tokensIn: 100 })]);
    await recordUsageDays(db, a.id, "laptop", [day("2026-07-01", { tokensIn: 120 })]); // re-report wins
    await recordUsageDays(db, a.id, "desktop", [day("2026-07-01", { tokensIn: 30 })]); // second machine adds
    const u = await buildOrgUsage(db, "acme", "all");
    expect(u.members).toHaveLength(1);
    expect(u.members[0].tokensIn).toBe(150);
  });

  it("aggregates members, sorts by tokens, and rolls a daily series", async () => {
    const db = await makeTestDb();
    const { a: alice } = await member(db, "alice", ["acme"]);
    const { a: bob } = await member(db, "bob", ["acme"]);
    await member(db, "mallory", ["other-org"]); // not in acme — must not appear
    await recordUsageDays(db, alice.id, "m", [day("2026-07-01", { tokensIn: 10 }), day("2026-07-02", { tokensIn: 10 })]);
    await recordUsageDays(db, bob.id, "m", [day("2026-07-01", { tokensIn: 9_000_000 })]);
    const u = await buildOrgUsage(db, "acme", "all");
    expect(u.members.map((m) => m.login)).toEqual(["bob", "alice"]);
    expect(u.memberCount).toBe(2);
    expect(u.members[1].activeDays).toBe(2);
    expect(u.daily.map((d) => d.date)).toEqual(["2026-07-01", "2026-07-02"]);
    expect(u.totals.sessions).toBe(6);
    expect(u.totals.tokens).toBe(u.members[0].tokens + u.members[1].tokens);
  });

  it("range cutoff excludes old days", async () => {
    const db = await makeTestDb();
    const { a } = await member(db, "alice", ["acme"]);
    const now = Date.parse("2026-07-05T12:00:00Z");
    await recordUsageDays(db, a.id, "m", [day("2026-07-04"), day("2026-05-01")]);
    const u = await buildOrgUsage(db, "acme", "7d", now);
    expect(u.daily).toHaveLength(1);
    expect(u.members[0].activeDays).toBe(1);
    expect(rangeCutoff("7d", now)).toBe("2026-06-29");
    expect(rangeCutoff("all", now)).toBeNull();
  });

  it("survives bigint-scale token sums", async () => {
    const db = await makeTestDb();
    const { a } = await member(db, "alice", ["acme"]);
    await recordUsageDays(db, a.id, "m", [day("2026-07-01", { tokensCache: 7_000_000_000 }), day("2026-07-02", { tokensCache: 7_000_000_000 })]);
    const u = await buildOrgUsage(db, "acme", "all");
    expect(u.members[0].tokensCache).toBe(14_000_000_000);
  });
});

describe("usage endpoints", () => {
  it("POST /api/usage/report 401s without a session, records with a Bearer", async () => {
    const db = await makeTestDb();
    const anon = mockRes();
    await reportHandler(deps(db))(req({ method: "POST", body: { days: [day("2026-07-01")] } }) as any, anon as any);
    expect(anon._status).toBe(401);

    const { token } = await member(db, "alice", ["acme"]);
    const res = mockRes();
    await reportHandler(deps(db))(req({ method: "POST", headers: { authorization: `Bearer ${token}` }, body: { machine: "laptop", days: [day("2026-07-01")] } }) as any, res as any);
    expect(res._body).toEqual({ recorded: 1 });
  });

  it("POST /api/usage/report 400s on an invalid body", async () => {
    const db = await makeTestDb();
    const { token } = await member(db, "alice", []);
    const res = mockRes();
    await reportHandler(deps(db))(req({ method: "POST", headers: { authorization: `Bearer ${token}` }, body: { days: "nope" } }) as any, res as any);
    expect(res._status).toBe(400);
  });

  it("GET /api/usage/org enforces sign-in and org membership, then returns the rollup", async () => {
    const db = await makeTestDb();
    const { a, token } = await member(db, "alice", ["acme"]);
    await recordUsageDays(db, a.id, "m", [day("2026-07-01")]);

    const anon = mockRes();
    await orgUsageHandler(deps(db))(req({ query: { scope: "acme" } }) as any, anon as any);
    expect(anon._status).toBe(401);

    const outsider = await member(db, "mallory", []);
    const forbidden = mockRes();
    await orgUsageHandler(deps(db))(req({ headers: { cookie: `${SESSION_COOKIE}=${outsider.token}` }, query: { scope: "acme" } }) as any, forbidden as any);
    expect(forbidden._status).toBe(403);

    const ok = mockRes();
    await orgUsageHandler(deps(db))(req({ headers: { cookie: `${SESSION_COOKIE}=${token}`, origin: webOrigins[0] }, query: { scope: "acme", range: "all" } }) as any, ok as any);
    expect((ok._body as any).scope).toBe("acme");
    expect((ok._body as any).members[0].login).toBe("alice");
    expect(ok._headers["access-control-allow-origin"]).toBe(webOrigins[0]);
    expect(ok._headers["access-control-allow-credentials"]).toBe("true");
  });

  it("GET /api/usage/org 400s on a bad range or missing scope", async () => {
    const db = await makeTestDb();
    const { token } = await member(db, "alice", []);
    const bad = mockRes();
    await orgUsageHandler(deps(db))(req({ headers: { cookie: `${SESSION_COOKIE}=${token}` }, query: { scope: "acme", range: "90d" } }) as any, bad as any);
    expect(bad._status).toBe(400);
    const missing = mockRes();
    await orgUsageHandler(deps(db))(req({ headers: { cookie: `${SESSION_COOKIE}=${token}` }, query: {} }) as any, missing as any);
    expect(missing._status).toBe(400);
  });
});
