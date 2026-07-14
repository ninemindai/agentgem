// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import {
  makeTestDb, makeAuth, mintSession, setAccountScopes,
  upsertInstallation, replaceOrgMembers, projectAttestation, accountBindings,
} from "@agentgem/aggregator";
import type { AppDb } from "@agentgem/aggregator";
import { orgBenchmarkHandler, benchmarkSettingsHandler, type OrgBenchmarkDeps } from "../../orgs/benchmark.js";

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
  r.setHeader = r.set;
  r.type = (t: string) => { r._headers["content-type"] = t; return r; };
  r.json = (b: unknown) => { r._body = b; return r; };
  r.send = (b: unknown) => { r._body = b; return r; };
  return r;
}
const req = (over: any = {}) => ({ method: "GET", path: "/", params: {}, query: {}, body: {}, headers: {}, get(n: string) { return (this.headers as any)[n.toLowerCase()]; }, ...over });

// Mirrors orgBenchmark.test.ts's att/bind helpers: a formatVersion-2 attestation carrying a
// per-model outcome histogram, plus the account_bindings row that ties its producer pubkey to a
// GitHub login (the join resolveOrgAccess/orgModelBenchmark share via org_members).
function att(pubkey: string, gemDigest: string, model: string, hist: { mostly?: number; partially?: number; not?: number }, gemName = "g") {
  return { formatVersion: 2, canonicalizerVersion: 3, gem: { name: gemName, digest: gemDigest },
    producer: { publicKey: pubkey, account: null },
    source: { harness: { id: "claude-code" }, models: [model], scan: { sessions: 10, spanDays: 1, firstMs: 0, lastMs: 0 },
      outcomeHistogram: [{ model, mostly: hist.mostly ?? 0, partially: hist.partially ?? 0, not: hist.not ?? 0 }] },
    ingredients: { skills: [], mcps: [] },
    evidence: { signalDigest: "sha256:d" }, signedAt: 1, signature: "x" } as never;
}
async function bind(db: AppDb, pubkey: string, login: string) {
  await db.insert(accountBindings).values({ pubkey, provider: "github", accountId: pubkey.slice(-3), accountLogin: login });
}

// App-authoritative membership (upsertInstallation + replaceOrgMembers), the same seed
// githubAppStore.test.ts uses to make resolveOrgAccess return via:"app" — acme has an admin (u1)
// and a plain member (u2); "mallory" never joins, so she's the non-member/stranger case. "beta"
// gets NO installation — carol's admin role there comes only from account_scopes (via:"scopes"),
// the non-App-governed case the settings POST must reject with 409.
async function setup(): Promise<{ deps: OrgBenchmarkDeps; adminToken: string; memberToken: string; strangerToken: string; betaAdminToken: string }> {
  const db: AppDb = await makeTestDb();
  const auth = makeAuth({ db, ...authOpts });
  await upsertInstallation(db, { installationId: 7, orgScope: "acme", repoSelection: "selected", suspended: false });
  await replaceOrgMembers(db, "acme", [{ login: "u1", role: "admin" }, { login: "u2", role: "member" }]);
  await projectAttestation(db, att("ed25519:m1", "sha256:d1", "claude-opus-4-8", { mostly: 2 }, "gemA"));
  await bind(db, "ed25519:m1", "u1");
  const mk = async (login: string) => {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser({ name: login, email: `${login}@example.com`, emailVerified: true, login } as never);
    await ctx.internalAdapter.createAccount({ userId: user.id, providerId: "github", accountId: login } as never);
    return user;
  };
  const admin = await mk("u1");
  const member = await mk("u2");
  const stranger = await mk("mallory");
  const carol = await mk("carol");
  await setAccountScopes(db, carol.id, [{ scope: "beta", role: "admin" }]);
  return {
    deps: { db, auth, webOrigins },
    adminToken: (await mintSession(auth, admin.id)).token,
    memberToken: (await mintSession(auth, member.id)).token,
    strangerToken: (await mintSession(auth, stranger.id)).token,
    betaAdminToken: (await mintSession(auth, carol.id)).token,
  };
}
const authed = (token: string, scope: string) => req({ params: { scope }, headers: { authorization: `Bearer ${token}` } });
const posted = (token: string, scope: string, body: unknown) => req({ method: "POST", params: { scope }, body, headers: { authorization: `Bearer ${token}` } });

describe("GET /api/orgs/:scope/benchmark", () => {
  it("200 with the three cuts for an admin; 403 not-admin for a member; 403 not-member for a stranger; 401 unauthenticated", async () => {
    const { deps, adminToken, memberToken, strangerToken } = await setup();

    let res = mockRes();
    await orgBenchmarkHandler(deps)(req({ params: { scope: "acme" } }) as any, res);
    expect(res._status).toBe(401);

    res = mockRes();
    await orgBenchmarkHandler(deps)(authed(strangerToken, "acme") as any, res);
    expect(res._status).toBe(403);
    expect(res._body).toMatchObject({ reason: "not-member" });

    res = mockRes();
    await orgBenchmarkHandler(deps)(authed(memberToken, "acme") as any, res);
    expect(res._status).toBe(403);
    expect(res._body).toMatchObject({ reason: "not-admin" });

    res = mockRes();
    await orgBenchmarkHandler(deps)(authed(adminToken, "acme") as any, res);
    expect(res._status).toBe(200);
    const body = res._body as {
      scope: string; modelBenchmark: { model: string; mostly: number }[]; effectiveness: { gemName: string }[]; members: { login: string }[];
      settings: { contributeAllowed: boolean; benchmarkViewEnabled: boolean }; governanceAvailable: boolean;
    };
    expect(body.scope).toBe("acme");
    expect(body.modelBenchmark).toEqual([expect.objectContaining({ model: "claude-opus-4-8", mostly: 2 })]);
    expect(body.effectiveness).toEqual([expect.objectContaining({ gemName: "gemA" })]);
    expect(body.members).toEqual([expect.objectContaining({ login: "u1" })]);
    // App-installed org: settings default to both-true, and governance is enforceable.
    expect(body.settings).toEqual({ contributeAllowed: true, benchmarkViewEnabled: true });
    expect(body.governanceAvailable).toBe(true);
  });

  it("returns empty panels + settings (same shape) when benchmarkViewEnabled is false", async () => {
    const { deps, adminToken } = await setup();
    const off = mockRes();
    await benchmarkSettingsHandler(deps)(posted(adminToken, "acme", { benchmarkViewEnabled: false }) as any, off);
    expect(off._status).toBe(200);

    const res = mockRes();
    await orgBenchmarkHandler(deps)(authed(adminToken, "acme") as any, res);
    expect(res._status).toBe(200);
    expect(res._body).toEqual({
      scope: "acme", modelBenchmark: [], effectiveness: [], members: [],
      settings: { contributeAllowed: true, benchmarkViewEnabled: false }, governanceAvailable: true,
    });
  });
});

describe("POST /api/orgs/:scope/benchmark/settings", () => {
  it("admin of an App-installed org persists; GET reflects it", async () => {
    const { deps, adminToken } = await setup();

    const res = mockRes();
    await benchmarkSettingsHandler(deps)(posted(adminToken, "acme", { contributeAllowed: false }) as any, res);
    expect(res._status).toBe(200);
    expect(res._body).toEqual({ contributeAllowed: false, benchmarkViewEnabled: true });

    const get = mockRes();
    await orgBenchmarkHandler(deps)(authed(adminToken, "acme") as any, get);
    expect((get._body as { settings: unknown }).settings).toEqual({ contributeAllowed: false, benchmarkViewEnabled: true });
  });

  it("403 not-admin for a member of an App-installed org", async () => {
    const { deps, memberToken } = await setup();
    const res = mockRes();
    await benchmarkSettingsHandler(deps)(posted(memberToken, "acme", { contributeAllowed: false }) as any, res);
    expect(res._status).toBe(403);
    expect(res._body).toMatchObject({ reason: "not-admin" });
  });

  it("409 app-required for an admin of a non-App org (role granted via account_scopes only)", async () => {
    const { deps, betaAdminToken } = await setup();
    const res = mockRes();
    await benchmarkSettingsHandler(deps)(posted(betaAdminToken, "beta", { contributeAllowed: false }) as any, res);
    expect(res._status).toBe(409);
    expect(res._body).toMatchObject({ reason: "app-required" });
  });

  it("401 unauthenticated; 403 not-member for a stranger", async () => {
    const { deps, strangerToken } = await setup();

    let res = mockRes();
    await benchmarkSettingsHandler(deps)(req({ method: "POST", params: { scope: "acme" }, body: { contributeAllowed: false } }) as any, res);
    expect(res._status).toBe(401);

    res = mockRes();
    await benchmarkSettingsHandler(deps)(posted(strangerToken, "acme", { contributeAllowed: false }) as any, res);
    expect(res._status).toBe(403);
    expect(res._body).toMatchObject({ reason: "not-member" });
  });
});
