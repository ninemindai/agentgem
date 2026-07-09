// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// 1b-Task 4: SSO handoff relocated out of auth/install.ts, redeem now mints a GENUINE better-auth
// session cookie (mintSessionCookie) instead of the legacy ag_session cookie. The load-bearing
// assertion below is that the redeem's Set-Cookie is accepted by resolveSession(auth, { cookie }) —
// a hand-forged cookie would fail that check (wrong HMAC signature), which is exactly the
// regression this test guards against.
import { describe, it, expect, afterEach, vi } from "vitest";
import { makeTestDb, makeAuth, mintSession, resolveSession } from "@agentgem/aggregator";
import { handoffStartHandler, handoffRedeemHandler, safeReturn } from "../handoff.js";
import type { HandoffDeps } from "../handoff.js";

const authOpts = {
  secret: "test-secret",
  baseURL: "http://localhost:4000",
  githubClientId: "gid",
  githubClientSecret: "gsecret",
  webOrigins: ["https://app.agentgem.ai"],
};

// databaseHooks.account.create.after (betterAuth.ts) calls fetchOrgMemberships(accessToken) with
// no injectable fetchImpl — stub the global so account creation below is deterministic/offline.
function stubGithubMembershipsFetch() {
  vi.stubGlobal("fetch", (async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch);
}

// A github account creation, same as betterAuthIntegration.test.ts's createGithubUser — the
// account.create.after hook anchors a same-id LEGACY `accounts` row (handoff_codes.account_id FKs
// to accounts.id, not "user".id), which is what makes createHandoffCode below possible at all.
async function githubUser(auth: ReturnType<typeof makeAuth>, login: string) {
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser({ name: login, email: `${login}@example.com`, emailVerified: true, login } as never);
  await ctx.internalAdapter.createAccount({ userId: user.id, providerId: "github", accountId: `gh-${login}`, accessToken: "gho_x" } as never);
  return user;
}

function mockRes() {
  const r: any = { _status: 200, _headers: {} as Record<string, string>, _body: undefined as unknown, _redirect: undefined as string | undefined };
  r.status = (c: number) => { r._status = c; return r; };
  r.setHeader = (k: string, v: string) => { r._headers[k.toLowerCase()] = v; return r; };
  r.json = (b: unknown) => { r._body = b; return r; };
  r.redirect = (c: number, u?: string) => { r._status = c; r._redirect = u; return r; };
  return r;
}
const mockReq = (over: any = {}) => ({ method: "GET", query: {}, headers: {}, ...over });

describe("SSO handoff (relocated to auth/handoff.ts, better-auth cookie mint)", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function setup() {
    stubGithubMembershipsFetch();
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const deps: HandoffDeps = { db, auth, config: { webOrigins: authOpts.webOrigins } };
    return { db, auth, deps };
  }

  it("start: no session -> 401; with a bearer, mints a single-use code", async () => {
    const { auth, deps } = await setup();
    const noauth = mockRes();
    await handoffStartHandler(deps)(mockReq({ method: "POST" }) as any, noauth as any);
    expect(noauth._status).toBe(401);

    const user = await githubUser(auth, "octocat");
    const { token } = await mintSession(auth, user.id);
    const start = mockRes();
    await handoffStartHandler(deps)(mockReq({ method: "POST", headers: { authorization: `Bearer ${token}` } }) as any, start as any);
    expect(typeof (start._body as any).code).toBe("string");
    expect(typeof (start._body as any).expiresAt).toBe("string");
  });

  it("redeem: valid code sets a genuine better-auth Set-Cookie resolveSession accepts, and 302s to the allowlisted return", async () => {
    const { auth, deps } = await setup();
    const user = await githubUser(auth, "trinity");
    const { token } = await mintSession(auth, user.id);
    const start = mockRes();
    await handoffStartHandler(deps)(mockReq({ method: "POST", headers: { authorization: `Bearer ${token}` } }) as any, start as any);
    const code = (start._body as any).code as string;

    const redeem = mockRes();
    await handoffRedeemHandler(deps)(mockReq({ query: { code, return: "https://app.agentgem.ai/gems" } }) as any, redeem as any);
    expect(redeem._redirect).toBe("https://app.agentgem.ai/gems");
    const cookie = redeem._headers["set-cookie"] as string;
    expect(cookie).toContain("session_token");

    // THE load-bearing proof: this is a real better-auth cookie, not hand-forged.
    const who = await resolveSession(auth, { cookie });
    expect(who).toEqual({ login: "trinity", avatarUrl: null, accountId: user.id });
  });

  it("redeem: invalid/expired/reused code 302s with ?auth_error=handoff and sets no cookie", async () => {
    const { auth, deps } = await setup();

    const garbage = mockRes();
    await handoffRedeemHandler(deps)(mockReq({ query: { code: "not-a-real-code", return: "https://app.agentgem.ai" } }) as any, garbage as any);
    expect(garbage._redirect).toContain("auth_error=handoff");
    expect(garbage._headers["set-cookie"]).toBeUndefined();

    const user = await githubUser(auth, "morpheus");
    const { token } = await mintSession(auth, user.id);
    const start = mockRes();
    await handoffStartHandler(deps)(mockReq({ method: "POST", headers: { authorization: `Bearer ${token}` } }) as any, start as any);
    const code = (start._body as any).code as string;

    const first = mockRes();
    await handoffRedeemHandler(deps)(mockReq({ query: { code, return: "https://app.agentgem.ai" } }) as any, first as any);
    expect(first._headers["set-cookie"]).toBeTruthy(); // first redeem succeeds

    const again = mockRes(); // single-use: second redeem of the SAME code fails
    await handoffRedeemHandler(deps)(mockReq({ query: { code, return: "https://app.agentgem.ai" } }) as any, again as any);
    expect(again._redirect).toContain("auth_error=handoff");
    expect(again._headers["set-cookie"]).toBeUndefined();
  });

  it("redeem: an off-allowlist return is refused (open-redirect guard)", async () => {
    const { auth, deps } = await setup();
    const user = await githubUser(auth, "cypher");
    const { token } = await mintSession(auth, user.id);
    const start = mockRes();
    await handoffStartHandler(deps)(mockReq({ method: "POST", headers: { authorization: `Bearer ${token}` } }) as any, start as any);
    const code = (start._body as any).code as string;

    const redeem = mockRes();
    await handoffRedeemHandler(deps)(mockReq({ query: { code, return: "https://evil.example/x" } }) as any, redeem as any);
    expect(redeem._redirect!.startsWith("https://app.agentgem.ai")).toBe(true);
    expect(redeem._redirect).not.toContain("evil.example");
  });

  it("safeReturn: allowlisted origin and sub-paths pass through; anything else falls back to the first web origin", () => {
    const cfg = { webOrigins: ["https://app.agentgem.ai", "https://app2.agentgem.ai"] };
    expect(safeReturn(cfg, "https://app.agentgem.ai/gems")).toBe("https://app.agentgem.ai/gems");
    expect(safeReturn(cfg, "https://app2.agentgem.ai")).toBe("https://app2.agentgem.ai");
    expect(safeReturn(cfg, "https://evil.example")).toBe("https://app.agentgem.ai");
    expect(safeReturn(cfg, undefined)).toBe("https://app.agentgem.ai");
  });
});
