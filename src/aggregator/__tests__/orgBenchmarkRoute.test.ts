// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import {
  makeTestDb, makeAuth, mintSession,
  upsertInstallation, replaceOrgMembers, projectAttestation, accountBindings,
} from "@agentgem/aggregator";
import type { AppDb } from "@agentgem/aggregator";
import { orgBenchmarkHandler, type OrgBenchmarkDeps } from "../../orgs/benchmark.js";

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
// and a plain member (u2); "mallory" never joins, so she's the non-member/stranger case.
async function setup(): Promise<{ deps: OrgBenchmarkDeps; adminToken: string; memberToken: string; strangerToken: string }> {
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
    const { token } = await mintSession(auth, user.id);
    return token;
  };
  return {
    deps: { db, auth, webOrigins },
    adminToken: await mk("u1"),
    memberToken: await mk("u2"),
    strangerToken: await mk("mallory"),
  };
}
const authed = (token: string, scope: string) => req({ params: { scope }, headers: { authorization: `Bearer ${token}` } });

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
    const body = res._body as { scope: string; modelBenchmark: { model: string; mostly: number }[]; effectiveness: { gemName: string }[]; members: { login: string }[] };
    expect(body.scope).toBe("acme");
    expect(body.modelBenchmark).toEqual([expect.objectContaining({ model: "claude-opus-4-8", mostly: 2 })]);
    expect(body.effectiveness).toEqual([expect.objectContaining({ gemName: "gemA" })]);
    expect(body.members).toEqual([expect.objectContaining({ login: "u1" })]);
  });
});
