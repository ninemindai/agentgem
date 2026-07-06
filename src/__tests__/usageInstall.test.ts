// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import {
  makeTestDb, upsertAccount, createSession, generateSessionToken, setAccountScopes,
  normalizeUsageReport, normalizeUsageModels, recordUsageDays, recordUsageModels, buildOrgUsage, rangeCutoff,
} from "@agentgem/aggregator";
import { reportHandler, orgUsageHandler, orgSettingsHandler } from "../usage/install.js";
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

// Rows default to scope "acme" (repo-owner attribution) so the acme org dashboard sees them;
// leak tests override scope.
const day = (date: string, over: Partial<{ scope: string; sessions: number; msgs: number; tokensIn: number; tokensOut: number; tokensCache: number; activeMs: number }> = {}) => ({ scope: "acme", date, sessions: 2, msgs: 10, tokensIn: 100, tokensOut: 50, tokensCache: 1000, activeMs: 3_600_000, ...over });

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
  it("normalizes scope: lowercased + trimmed, missing → unattributed", () => {
    const r = normalizeUsageReport({ days: [day("2026-07-01", { scope: "  NineMind " }), { ...day("2026-07-02"), scope: undefined }] });
    expect(r?.days[0].scope).toBe("ninemind");
    expect(r?.days[1].scope).toBe("");
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

  it("anti-leak: only rows attributed to the org count; personal view folds in unattributed", async () => {
    const db = await makeTestDb();
    const { a } = await member(db, "alice", ["acme"]);
    await recordUsageDays(db, a.id, "m", [
      day("2026-07-01", { tokensIn: 100 }),                          // acme work
      day("2026-07-01", { scope: "alice", tokensIn: 40 }),           // personal repo
      day("2026-07-01", { scope: "other-org", tokensIn: 7 }),        // different org
      day("2026-07-02", { scope: "", tokensIn: 3 }),                 // no repo / no remote
    ]);
    const org = await buildOrgUsage(db, "acme", "all");
    expect(org.members[0].tokensIn).toBe(100);                        // ONLY the acme-attributed row
    expect(org.daily).toHaveLength(1);
    const personal = await buildOrgUsage(db, "alice", "all", Date.now(), { includeUnattributed: true });
    expect(personal.members[0].tokensIn).toBe(43);                    // own repos + unattributed, no org rows
  });

  it("matches scope case-insensitively (reporter lowercases, query lowercases)", async () => {
    const db = await makeTestDb();
    const { a } = await member(db, "alice", ["AcmeOrg"]);
    await recordUsageDays(db, a.id, "m", [day("2026-07-01", { scope: "acmeorg" })]);
    const u = await buildOrgUsage(db, "AcmeOrg", "all");              // scope param as GitHub cases it
    expect(u.members).toHaveLength(1);
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

describe("membership freshness on GET /api/usage/org", () => {
  it("403s with reason=stale when the org grant aged out, but the OWN-login scope never goes stale", async () => {
    const db = await makeTestDb();
    const { a, token } = await member(db, "alice", ["acme"]);
    await recordUsageDays(db, a.id, "m", [day("2026-07-01"), day("2026-07-02", { scope: "" })]);
    await db.execute(sql`update account_scopes set captured_at = now() - interval '30 days' where account_id = ${a.id}::uuid`);

    const stale = mockRes();
    await orgUsageHandler(deps(db))(req({ headers: { cookie: `${SESSION_COOKIE}=${token}` }, query: { scope: "acme" } }) as any, stale as any);
    expect(stale._status).toBe(403);
    expect((stale._body as any).reason).toBe("stale");

    // scope = the caller's own login: personal view stays available regardless of capture age
    const own = mockRes();
    await orgUsageHandler(deps(db))(req({ headers: { cookie: `${SESSION_COOKIE}=${token}` }, query: { scope: "alice", range: "all" } }) as any, own as any);
    expect(own._status).toBe(200);
    expect((own._body as any).members[0].login).toBe("alice");
  });

  it("a fresh re-capture clears the stale gate", async () => {
    const db = await makeTestDb();
    const { a, token } = await member(db, "alice", ["acme"]);
    await recordUsageDays(db, a.id, "m", [day("2026-07-01")]);
    await db.execute(sql`update account_scopes set captured_at = now() - interval '30 days' where account_id = ${a.id}::uuid`);
    await setAccountScopes(db, a.id, ["alice", "acme"]); // simulates re-sign-in / re-bind
    const ok = mockRes();
    await orgUsageHandler(deps(db))(req({ headers: { cookie: `${SESSION_COOKIE}=${token}` }, query: { scope: "acme", range: "all" } }) as any, ok as any);
    expect(ok._status).toBe(200);
  });
});

describe("model breakdowns", () => {
  const modelRow = (over: Partial<{ scope: string; date: string; agent: string; model: string; sessions: number; tokens: number }> = {}) =>
    ({ scope: "acme", date: "2026-07-01", agent: "claude", model: "claude-fable-5", sessions: 3, tokens: 500, ...over });

  it("normalizeUsageModels drops malformed rows, lowercases scope, never rejects", () => {
    expect(normalizeUsageModels(undefined)).toEqual([]);
    expect(normalizeUsageModels([modelRow({ scope: " ACME " }), { date: "bad" }, "junk"])).toEqual([
      { scope: "acme", date: "2026-07-01", agent: "claude", model: "claude-fable-5", sessions: 3, tokens: 500 },
    ]);
  });

  it("records + aggregates per model/agent under the same scope boundary", async () => {
    const db = await makeTestDb();
    const { a } = await member(db, "alice", ["acme"]);
    await recordUsageDays(db, a.id, "m", [day("2026-07-01")]);
    await recordUsageModels(db, a.id, "m", [
      modelRow({ tokens: 900 }),
      modelRow({ date: "2026-07-02", tokens: 100 }),                         // same model, second day
      modelRow({ agent: "codex", model: "gpt-5.2-codex", tokens: 400 }),
      modelRow({ scope: "other-org", model: "leaky-model", tokens: 9_999 }), // must NOT appear for acme
    ]);
    const u = await buildOrgUsage(db, "acme", "all");
    expect(u.models).toEqual([
      { agent: "claude", model: "claude-fable-5", sessions: 6, tokens: 1000 },
      { agent: "codex", model: "gpt-5.2-codex", sessions: 3, tokens: 400 },
    ]);
    expect(u.agents).toEqual([
      { agent: "claude", sessions: 6, tokens: 1000 },
      { agent: "codex", sessions: 3, tokens: 400 },
    ]);
  });

  it("POST /api/usage/report accepts the models array", async () => {
    const db = await makeTestDb();
    const { token } = await member(db, "alice", ["acme"]);
    const res = mockRes();
    await reportHandler(deps(db))(req({ method: "POST", headers: { authorization: `Bearer ${token}` }, body: { days: [day("2026-07-01")], models: [modelRow()] } }) as any, res as any);
    expect(res._body).toEqual({ recorded: 1 });
    const u = await buildOrgUsage(db, "acme", "all");
    expect(u.models).toHaveLength(1);
  });
});

describe("org settings (admin-gated) + retention", () => {
  async function adminMember(db: any, login: string, scope: string, role: "admin" | "member") {
    const a = await upsertAccount(db, { provider: "github", accountId: login, login });
    await setAccountScopes(db, a.id, [{ scope: login, role: "self" }, { scope, role }]);
    const { token } = generateSessionToken();
    await createSession(db, a.id, token, 60_000);
    return { a, token };
  }

  it("GET returns defaults + viewerRole; PUT is admin-only", async () => {
    const db = await makeTestDb();
    const admin = await adminMember(db, "alice", "acme", "admin");
    const plain = await adminMember(db, "bob", "acme", "member");

    const g = mockRes();
    await orgSettingsHandler(deps(db))(req({ headers: { authorization: `Bearer ${plain.token}` }, query: { scope: "acme" } }) as any, g as any);
    expect(g._body).toMatchObject({ retentionDays: null, viewerRole: "member" });

    const deniedPut = mockRes();
    await orgSettingsHandler(deps(db))(req({ method: "PUT", headers: { authorization: `Bearer ${plain.token}` }, query: { scope: "acme" }, body: { retentionDays: 30, dashboardEnabled: true } }) as any, deniedPut as any);
    expect(deniedPut._status).toBe(403);

    const okPut = mockRes();
    await orgSettingsHandler(deps(db))(req({ method: "PUT", headers: { authorization: `Bearer ${admin.token}` }, query: { scope: "acme" }, body: { retentionDays: 30, dashboardEnabled: true } }) as any, okPut as any);
    expect(okPut._body).toMatchObject({ retentionDays: 30, updatedBy: "alice", viewerRole: "admin" });

    const badPut = mockRes();
    await orgSettingsHandler(deps(db))(req({ method: "PUT", headers: { authorization: `Bearer ${admin.token}` }, query: { scope: "acme" }, body: { retentionDays: 3, dashboardEnabled: true } }) as any, badPut as any);
    expect(badPut._status).toBe(400); // below the 7-day floor

    const anon = mockRes();
    await orgSettingsHandler(deps(db))(req({ query: { scope: "acme" } }) as any, anon as any);
    expect(anon._status).toBe(401);
  });

  it("retention prunes ONLY this org's old rows (scope-bounded), and runs post-ingest", async () => {
    const db = await makeTestDb();
    const admin = await adminMember(db, "alice", "acme", "admin");
    const old = "2020-01-01";
    await recordUsageDays(db, admin.a.id, "m", [
      day(old), day("2026-07-01"),
      day(old, { scope: "alice", tokensIn: 77 }), // personal history must survive org retention
    ]);
    await recordUsageModels(db, admin.a.id, "m", [{ scope: "acme", date: old, agent: "claude", model: "x", sessions: 1, tokens: 5 }]);

    const put = mockRes();
    await orgSettingsHandler(deps(db))(req({ method: "PUT", headers: { authorization: `Bearer ${admin.token}` }, query: { scope: "acme" }, body: { retentionDays: 30, dashboardEnabled: true } }) as any, put as any);

    const org = await buildOrgUsage(db, "acme", "all");
    expect(org.daily.map((d) => d.date)).toEqual(["2026-07-01"]); // old acme day pruned
    expect(org.models).toEqual([]);                                // old model slice pruned
    const personal = await buildOrgUsage(db, "alice", "all", Date.now(), { includeUnattributed: true });
    expect(personal.members[0].tokensIn).toBe(77);                 // personal history intact

    // post-ingest: a new report containing an out-of-window acme day gets pruned immediately
    const rep = mockRes();
    await reportHandler(deps(db))(req({ method: "POST", headers: { authorization: `Bearer ${admin.token}` }, body: { days: [day("2020-02-02")] } }) as any, rep as any);
    const after = await buildOrgUsage(db, "acme", "all");
    expect(after.daily.map((d) => d.date)).toEqual(["2026-07-01"]);
  });
});

describe("v3: member drill-down + visibility toggle", () => {
  async function roleMember(db: any, login: string, scope: string, role: "admin" | "member") {
    const a = await upsertAccount(db, { provider: "github", accountId: login, login });
    await setAccountScopes(db, a.id, [{ scope: login, role: "self" }, { scope, role }]);
    const { token } = generateSessionToken();
    await createSession(db, a.id, token, 60_000);
    return { a, token };
  }

  it("?member= narrows members, daily, and models to that member (still org-scope-bounded)", async () => {
    const db = await makeTestDb();
    const alice = await roleMember(db, "alice", "acme", "member");
    const bob = await roleMember(db, "bob", "acme", "member");
    await recordUsageDays(db, alice.a.id, "m", [day("2026-07-01", { tokensIn: 10 })]);
    await recordUsageDays(db, bob.a.id, "m", [day("2026-07-02", { tokensIn: 999 })]);
    await recordUsageModels(db, alice.a.id, "m", [{ scope: "acme", date: "2026-07-01", agent: "claude", model: "m1", sessions: 1, tokens: 5 }]);
    await recordUsageModels(db, bob.a.id, "m", [{ scope: "acme", date: "2026-07-02", agent: "codex", model: "m2", sessions: 1, tokens: 7 }]);

    const res = mockRes();
    // member match is case-insensitive, like scope (a shared ?member=BOB URL must not go empty)
    await orgUsageHandler(deps(db))(req({ headers: { cookie: `${SESSION_COOKIE}=${alice.token}` }, query: { scope: "acme", range: "all", member: "BOB" } }) as any, res as any);
    const u = res._body as any;
    expect(u.members.map((m: any) => m.login)).toEqual(["bob"]);
    expect(u.daily.map((d: any) => d.date)).toEqual(["2026-07-02"]);
    expect(u.models).toEqual([{ agent: "codex", model: "m2", sessions: 1, tokens: 7 }]);
  });

  it("disabling the dashboard 403s members with reason=disabled, but admins still see it", async () => {
    const db = await makeTestDb();
    const admin = await roleMember(db, "alice", "acme", "admin");
    const plain = await roleMember(db, "bob", "acme", "member");
    await recordUsageDays(db, admin.a.id, "m", [day("2026-07-01")]);

    const put = mockRes();
    await orgSettingsHandler(deps(db))(req({ method: "PUT", headers: { authorization: `Bearer ${admin.token}` }, query: { scope: "acme" }, body: { retentionDays: null, dashboardEnabled: false } }) as any, put as any);
    expect((put._body as any).dashboardEnabled).toBe(false);

    const blocked = mockRes();
    await orgUsageHandler(deps(db))(req({ headers: { cookie: `${SESSION_COOKIE}=${plain.token}` }, query: { scope: "acme", range: "all" } }) as any, blocked as any);
    expect(blocked._status).toBe(403);
    expect((blocked._body as any).reason).toBe("disabled");

    const adminView = mockRes();
    await orgUsageHandler(deps(db))(req({ headers: { cookie: `${SESSION_COOKIE}=${admin.token}` }, query: { scope: "acme", range: "all" } }) as any, adminView as any);
    expect(adminView._status).toBe(200);

    // personal view is never affected by org policy
    const own = mockRes();
    await orgUsageHandler(deps(db))(req({ headers: { cookie: `${SESSION_COOKIE}=${plain.token}` }, query: { scope: "bob", range: "all" } }) as any, own as any);
    expect(own._status).toBe(200);
  });

  it("the self role may PUT settings for their own-login scope", async () => {
    const db = await makeTestDb();
    const { token } = await roleMember(db, "alice", "acme", "member");
    const put = mockRes();
    await orgSettingsHandler(deps(db))(req({ method: "PUT", headers: { authorization: `Bearer ${token}` }, query: { scope: "alice" }, body: { retentionDays: 30, dashboardEnabled: true } }) as any, put as any);
    expect((put._body as any)).toMatchObject({ retentionDays: 30, viewerRole: "self" });
  });

  it("PUT is a PARTIAL update: absent fields keep their stored value (old retention-only bodies work)", async () => {
    const db = await makeTestDb();
    const admin = await roleMember(db, "alice", "acme", "admin");
    // Disable the dashboard, then send a retention-only body (the pre-toggle client shape):
    // the visibility flag must survive — the concurrent-admin / stale-bundle guarantee.
    await orgSettingsHandler(deps(db))(req({ method: "PUT", headers: { authorization: `Bearer ${admin.token}` }, query: { scope: "acme" }, body: { dashboardEnabled: false } }) as any, mockRes() as any);
    const put = mockRes();
    await orgSettingsHandler(deps(db))(req({ method: "PUT", headers: { authorization: `Bearer ${admin.token}` }, query: { scope: "acme" }, body: { retentionDays: 30 } }) as any, put as any);
    expect(put._body).toMatchObject({ retentionDays: 30, dashboardEnabled: false });
  });

  it("PUT 400s on a present-but-mistyped field", async () => {
    const db = await makeTestDb();
    const admin = await roleMember(db, "alice", "acme", "admin");
    const badBool = mockRes();
    await orgSettingsHandler(deps(db))(req({ method: "PUT", headers: { authorization: `Bearer ${admin.token}` }, query: { scope: "acme" }, body: { dashboardEnabled: "yes" } }) as any, badBool as any);
    expect(badBool._status).toBe(400);
    const badDays = mockRes();
    await orgSettingsHandler(deps(db))(req({ method: "PUT", headers: { authorization: `Bearer ${admin.token}` }, query: { scope: "acme" }, body: { retentionDays: "30" } }) as any, badDays as any);
    expect(badDays._status).toBe(400);
  });
});

describe("agent/model facets", () => {
  const slice = (over: Partial<{ scope: string; date: string; agent: string; model: string; sessions: number; tokens: number }> = {}) =>
    ({ scope: "acme", date: "2026-07-01", agent: "claude", model: "claude-fable-5", sessions: 3, tokens: 900, ...over });

  async function seeded() {
    const db = await makeTestDb();
    const alice = await member(db, "alice", ["acme"]);
    const bob = await member(db, "bob", ["acme"]);
    await recordUsageDays(db, alice.a.id, "m", [day("2026-07-01", { tokensIn: 10 })]);
    await recordUsageDays(db, bob.a.id, "m", [day("2026-07-02", { tokensIn: 20 })]);
    await recordUsageModels(db, alice.a.id, "m", [slice(), slice({ agent: "codex", model: "gpt-5.2-codex", tokens: 100 })]);
    await recordUsageModels(db, bob.a.id, "m", [slice({ date: "2026-07-02", tokens: 500 })]);
    return { db, alice, bob };
  }

  it("unfiltered payload carries facets and filtered:false, day-rollup metrics intact", async () => {
    const { db } = await seeded();
    const u = await buildOrgUsage(db, "acme", "all");
    expect(u.filtered).toBe(false);
    expect(u.facets.agents).toEqual(["claude", "codex"]);
    expect(u.facets.models).toEqual(["claude-fable-5", "gpt-5.2-codex"]);
    expect(u.totals.tokensIn).toBe(30); // from usage_days, untouched
  });

  it("agent filter re-aggregates members/daily/models from the slices (sessions+tokens only)", async () => {
    const { db } = await seeded();
    const u = await buildOrgUsage(db, "acme", "all", Date.now(), { agent: "claude" });
    expect(u.filtered).toBe(true);
    expect(u.members.map((m) => [m.login, m.tokens, m.sessions])).toEqual([["alice", 900, 3], ["bob", 500, 3]]);
    expect(u.members.every((m) => m.tokensIn === 0 && m.activeMs === 0)).toBe(true); // zeroed, not fabricated
    expect(u.daily.map((d) => [d.date, d.tokens])).toEqual([["2026-07-01", 900], ["2026-07-02", 500]]);
    expect(u.models.every((m) => m.agent === "claude")).toBe(true);
    expect(u.facets.agents).toEqual(["claude", "codex"]); // options stay unfiltered
    expect(u.totals.tokens).toBe(1400);
  });

  it("model filter composes with the member drill-down and the scope boundary", async () => {
    const { db, alice } = await seeded();
    await recordUsageModels(db, alice.a.id, "m", [slice({ scope: "other-org", model: "leaky", tokens: 9999 })]);
    const u = await buildOrgUsage(db, "acme", "all", Date.now(), { model: "claude-fable-5", memberLogin: "ALICE" });
    expect(u.members.map((m) => m.login)).toEqual(["alice"]);
    expect(u.totals.tokens).toBe(900);
    expect(u.facets.models).not.toContain("leaky"); // other-scope slices never leak into facets
  });

  it("GET /api/usage/org passes agent/model through and 400s oversized values", async () => {
    const { db } = await seeded();
    const { token } = await member(db, "carol", ["acme"]);
    const ok = mockRes();
    await orgUsageHandler(deps(db))(req({ headers: { cookie: `${SESSION_COOKIE}=${token}` }, query: { scope: "acme", range: "all", agent: "codex" } }) as any, ok as any);
    expect((ok._body as any).filtered).toBe(true);
    expect((ok._body as any).totals.tokens).toBe(100);
    const bad = mockRes();
    await orgUsageHandler(deps(db))(req({ headers: { cookie: `${SESSION_COOKIE}=${token}` }, query: { scope: "acme", model: "x".repeat(101) } }) as any, bad as any);
    expect(bad._status).toBe(400);
  });
});

describe("stale-slice purge (replace-by-group)", () => {
  it("a re-report of the same (scope, day) deletes slices whose (agent, model) key vanished", async () => {
    const db = await makeTestDb();
    const { a } = await member(db, "alice", ["acme"]);
    // Report 1: ongoing session's last-seen model is sonnet.
    await recordUsageModels(db, a.id, "m", [{ scope: "acme", date: "2026-07-01", agent: "claude", model: "claude-sonnet-5", sessions: 1, tokens: 100 }]);
    // Report 2 (same day re-sent): the session switched — only fable appears now.
    await recordUsageModels(db, a.id, "m", [{ scope: "acme", date: "2026-07-01", agent: "claude", model: "claude-fable-5", sessions: 1, tokens: 500 }]);
    const u = await buildOrgUsage(db, "acme", "all");
    expect(u.models).toEqual([{ agent: "claude", model: "claude-fable-5", sessions: 1, tokens: 500 }]); // sonnet slice purged
    const f = await buildOrgUsage(db, "acme", "all", Date.now(), { agent: "claude" });
    expect(f.totals.sessions).toBe(1); // no double count in the filtered view
  });

  it("the purge is group-bounded: other days, scopes, and machines survive", async () => {
    const db = await makeTestDb();
    const { a } = await member(db, "alice", ["acme"]);
    await recordUsageModels(db, a.id, "laptop", [
      { scope: "acme", date: "2026-07-01", agent: "claude", model: "m1", sessions: 1, tokens: 10 },
      { scope: "acme", date: "2026-06-30", agent: "claude", model: "m2", sessions: 1, tokens: 20 },
      { scope: "alice", date: "2026-07-01", agent: "claude", model: "m3", sessions: 1, tokens: 30 },
    ]);
    await recordUsageModels(db, a.id, "desktop", [{ scope: "acme", date: "2026-07-01", agent: "codex", model: "m4", sessions: 1, tokens: 40 }]);
    // Re-report ONLY laptop's acme/2026-07-01 group with a different model.
    await recordUsageModels(db, a.id, "laptop", [{ scope: "acme", date: "2026-07-01", agent: "claude", model: "m1b", sessions: 1, tokens: 11 }]);
    const u = await buildOrgUsage(db, "acme", "all");
    const keys = u.models.map((m) => m.model).sort();
    expect(keys).toEqual(["m1b", "m2", "m4"]); // m1 replaced; other day + other machine intact
    const personal = await buildOrgUsage(db, "alice", "all", Date.now(), { includeUnattributed: true });
    expect(personal.models.map((m) => m.model)).toEqual(["m3"]); // other scope untouched
  });
});

describe("model-facet cascade", () => {
  it("model options narrow under a selected agent; agent options never narrow", async () => {
    const db = await makeTestDb();
    const { a } = await member(db, "alice", ["acme"]);
    await recordUsageModels(db, a.id, "m", [
      { scope: "acme", date: "2026-07-01", agent: "claude", model: "claude-fable-5", sessions: 1, tokens: 10 },
      { scope: "acme", date: "2026-07-01", agent: "codex", model: "gpt-5.2-codex", sessions: 1, tokens: 20 },
    ]);
    const u = await buildOrgUsage(db, "acme", "all", Date.now(), { agent: "codex" });
    expect([...u.facets.agents].sort()).toEqual(["claude", "codex"]); // full — switching stays possible
    expect(u.facets.models).toEqual(["gpt-5.2-codex"]);     // narrowed — no impossible combos offered
  });
});
