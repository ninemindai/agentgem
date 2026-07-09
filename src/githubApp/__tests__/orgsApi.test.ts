// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  makeTestDb, makeAuth, mintSession,
  upsertInstallation, upsertOrgMember, replaceOrgRepoSkills,
  setInstallationSuspended, setAccountScopes,
} from "@agentgem/aggregator";
import type { AppDb } from "@agentgem/aggregator";
import type { Http } from "@agentgem/distribute";
import { InstallationTokens } from "../client.js";
import { orgAppHandler, orgSkillsHandler, orgSkillBodyHandler, type OrgsApiDeps } from "../orgsApi.js";

const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const webOrigins = ["https://app.agentgem.ai"];

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
const req = (over: any = {}) => ({ method: "GET", path: "/", query: {}, body: {}, headers: {}, get(n: string) { return (this.headers as any)[n.toLowerCase()]; }, ...over });

const bodyHttp: Http = async (url) => {
  if (url.includes("/contents/eng/deploy/SKILL.md")) {
    return { status: 200, text: async () => JSON.stringify({ content: Buffer.from("# deploy body").toString("base64"), encoding: "base64" }) };
  }
  return { status: 404, text: async () => "{}" };
};
const tokenFetch = (async () => ({ ok: true, status: 200, json: async () => ({ token: "itok", expires_at: new Date(Date.now() + 3_600_000).toISOString() }) })) as unknown as typeof fetch;

const authOpts = {
  secret: "test-secret", baseURL: "http://localhost:4000",
  githubClientId: "gid", githubClientSecret: "gsecret",
  webOrigins,
};

async function setup(): Promise<{ deps: OrgsApiDeps; memberToken: string; strangerToken: string; aliceAccountId: string }> {
  const db: AppDb = await makeTestDb();
  const auth = makeAuth({ db, ...authOpts });
  await upsertInstallation(db, { installationId: 7, orgScope: "acme", repoSelection: "selected", suspended: false });
  await upsertOrgMember(db, "acme", "alice", "member");
  await replaceOrgRepoSkills(db, "acme", "acme/skills", [
    { sourceId: "org:acme/skills", path: "eng/deploy/SKILL.md", division: "eng", name: "deploy", repo: "acme/skills", description: "d" },
  ]);
  let aliceAccountId = "";
  const mk = async (login: string) => {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser({ name: login, email: `${login}@example.com`, emailVerified: true, login } as never);
    await ctx.internalAdapter.createAccount({ userId: user.id, providerId: "github", accountId: login } as never);
    if (login === "alice") aliceAccountId = user.id;
    const { token } = await mintSession(auth, user.id);
    return token;
  };
  return {
    deps: { db, auth, webOrigins, tokens: new InstallationTokens({ appId: "1", privateKey: pem }, tokenFetch), http: bodyHttp },
    memberToken: await mk("alice"),
    strangerToken: await mk("mallory"),
    aliceAccountId,
  };
}
const authed = (token: string, query: any) => req({ query, headers: { authorization: `Bearer ${token}` } });

describe("GET /api/orgs/app", () => {
  it("reports install + membership; signed-out callers get isMember:false", async () => {
    const { deps, memberToken } = await setup();
    let res = mockRes();
    await orgAppHandler(deps)(authed(memberToken, { scope: "acme" }) as any, res);
    expect(res._body).toEqual({ installed: true, isMember: true, role: "member" });
    res = mockRes();
    await orgAppHandler(deps)(req({ query: { scope: "acme" } }) as any, res);
    expect(res._body).toEqual({ installed: true, isMember: false, role: null });
    res = mockRes();
    await orgAppHandler(deps)(req({ query: { scope: "globex" } }) as any, res);
    expect(res._body).toEqual({ installed: false, isMember: false, role: null });
  });
});

describe("GET /api/orgs/skills", () => {
  it("401 unsigned, 403 non-member, 200 member with the list", async () => {
    const { deps, memberToken, strangerToken } = await setup();
    let res = mockRes();
    await orgSkillsHandler(deps)(req({ query: { scope: "acme" } }) as any, res);
    expect(res._status).toBe(401);
    res = mockRes();
    await orgSkillsHandler(deps)(authed(strangerToken, { scope: "acme" }) as any, res);
    expect(res._status).toBe(403);
    res = mockRes();
    await orgSkillsHandler(deps)(authed(memberToken, { scope: "acme" }) as any, res);
    expect(res._status).toBe(200);
    expect((res._body as { skills: { name: string }[] }).skills.map((s) => s.name)).toEqual(["deploy"]);
  });

  it("suspended installation serves zero rows even to a member who still passes the gate", async () => {
    const { deps, memberToken, aliceAccountId } = await setup();
    await setInstallationSuspended(deps.db, 7, true);
    // Same pattern as the skill-body suspended-404 test: capture acme for alice so
    // resolveOrgAccess falls back to captured scopes and the member gate still passes,
    // reaching the suspended-installation check inside orgSkillsHandler.
    await setAccountScopes(deps.db, aliceAccountId, [{ scope: "acme", role: "member" }]);
    const res = mockRes();
    await orgSkillsHandler(deps)(authed(memberToken, { scope: "acme" }) as any, res);
    expect(res._status).toBe(200);
    expect(res._body).toEqual({ scope: "acme", skills: [] }); // suspended behaves as uninstalled
  });
});

describe("GET /api/orgs/skill-body", () => {
  it("member gets the markdown; boundary violations 404; non-member 403", async () => {
    const { deps, memberToken, strangerToken } = await setup();
    const q = { scope: "acme", source: "org:acme/skills", path: "eng/deploy/SKILL.md" };
    let res = mockRes();
    await orgSkillBodyHandler(deps)(authed(memberToken, q) as any, res);
    expect(res._status).toBe(200);
    expect(res._body).toBe("# deploy body");
    res = mockRes();
    await orgSkillBodyHandler(deps)(authed(strangerToken, q) as any, res);
    expect(res._status).toBe(403);
    res = mockRes(); // unknown (source,path) for this org → 404, no GitHub fetch
    await orgSkillBodyHandler(deps)(authed(memberToken, { ...q, path: "eng/other/SKILL.md" }) as any, res);
    expect(res._status).toBe(404);
    res = mockRes(); // traversal-shaped path → 400
    await orgSkillBodyHandler(deps)(authed(memberToken, { ...q, path: "../../etc/passwd" }) as any, res);
    expect(res._status).toBe(400);
  });

  it("503 when the App tokens are unconfigured", async () => {
    const { deps, memberToken } = await setup();
    const res = mockRes();
    await orgSkillBodyHandler({ ...deps, tokens: null })(authed(memberToken, { scope: "acme", source: "org:acme/skills", path: "eng/deploy/SKILL.md" }) as any, res);
    expect(res._status).toBe(503);
  });

  it("502 on upstream failure, and the error body never contains the token", async () => {
    const { deps, memberToken } = await setup();
    const failingHttp: Http = async () => { throw new Error("boom upstream"); };
    const res = mockRes();
    await orgSkillBodyHandler({ ...deps, http: failingHttp })(authed(memberToken, { scope: "acme", source: "org:acme/skills", path: "eng/deploy/SKILL.md" }) as any, res);
    expect(res._status).toBe(502);
    expect(JSON.stringify(res._body)).not.toContain("itok"); // installation token never leaks
  });

  it("404 when the installation is suspended (no active installation)", async () => {
    const { deps, memberToken, aliceAccountId } = await setup();
    await setInstallationSuspended(deps.db, 7, true);
    // A suspended installation revokes membership via the member gate. To reach the
    // installationForScope-suspended 404 branch, capture acme scope for alice so
    // resolveOrgAccess bypasses the install-status check and returns "ok", allowing
    // the request to pass the member gate and reach line 96 where inst.suspended fires.
    await setAccountScopes(deps.db, aliceAccountId, [{ scope: "acme", role: "member" }]);
    const res = mockRes();
    await orgSkillBodyHandler(deps)(authed(memberToken, { scope: "acme", source: "org:acme/skills", path: "eng/deploy/SKILL.md" }) as any, res);
    expect(res._status).toBe(404);
    expect(res._body).toEqual({ error: "no active installation" });
  });
});
