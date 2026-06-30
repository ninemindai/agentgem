// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { makeTestDb } from "@agentgem/aggregator";
import { resolveSession } from "@agentgem/aggregator";
import { loginHandler, callbackHandler, meHandler, logoutHandler } from "../auth/install.js";
import { SESSION_COOKIE } from "../auth/cookie.js";

const cfg = {
  clientId: "cid", clientSecret: "sec", webOrigins: ["https://app.agentgem.ai"],
  cookieDomain: ".agentgem.ai", callbackUrl: "https://api.agentgem.ai/api/auth/github/callback",
  stateSecret: "ssecret", sessionTtlMs: 3_600_000,
};
// Minimal mock req/res capturing what the handlers do.
function mockRes() {
  const r: any = { _status: 200, _headers: {} as Record<string, string>, _body: undefined as unknown, _redirect: undefined as string | undefined };
  r.status = (c: number) => { r._status = c; return r; };
  r.set = (k: string, v: string) => { r._headers[k.toLowerCase()] = v; return r; };
  r.setHeader = (k: string, v: string) => { r._headers[k.toLowerCase()] = v; return r; };
  r.json = (b: unknown) => { r._body = b; return r; };
  r.send = (b: unknown) => { r._body = b; return r; };
  r.redirect = (c: number, u?: string) => { if (typeof c === "number") { r._status = c; r._redirect = u; } else { r._redirect = c as unknown as string; } return r; };
  return r;
}
const mockReq = (over: any = {}) => ({ method: "GET", path: "/", query: {}, headers: {}, get(n: string) { return (this.headers as any)[n.toLowerCase()]; }, ...over });

const deps = (db: any) => ({ db, verifier: { verify: async () => ({ provider: "github", accountId: "42", login: "octocat" }) }, exchangeCode: async () => "gh-token", config: cfg });

describe("auth handlers", () => {
  it("login rejects an off-allowlist return and 302s to github for an allowed one", async () => {
    { const db = await makeTestDb();
      const bad = mockRes();
      await loginHandler(deps(db))(mockReq({ query: { return: "https://evil.example/x" } }) as any, bad as any);
      expect(bad._status).toBe(400);

      const ok = mockRes();
      await loginHandler(deps(db))(mockReq({ query: { return: "https://app.agentgem.ai/gems" } }) as any, ok as any);
      expect(ok._redirect).toContain("https://github.com/login/oauth/authorize");
      expect(ok._redirect).toContain("state=");
      expect(ok._redirect).toContain("scope=read%3Auser");
    }
  });

  it("callback exchanges + verifies + sets the session cookie + 302s to returnTo", async () => {
    { const db = await makeTestDb();
      // produce a valid state by running login first and pulling it out of the redirect URL
      const login = mockRes();
      await loginHandler(deps(db))(mockReq({ query: { return: "https://app.agentgem.ai/gems" } }) as any, login as any);
      const state = new URL(login._redirect!).searchParams.get("state")!;

      const cb = mockRes();
      await callbackHandler(deps(db))(mockReq({ query: { code: "abc", state } }) as any, cb as any);
      expect(cb._redirect).toBe("https://app.agentgem.ai/gems");
      const setCookie = cb._headers["set-cookie"] as string;
      expect(setCookie).toContain(`${SESSION_COOKIE}=`);
      expect(setCookie).toContain("HttpOnly");
      // the session is resolvable
      const token = setCookie.split(";")[0].split("=")[1];
      expect((await resolveSession(db, token))?.login).toBe("octocat");
    }
  });

  it("callback with a bad state redirects with auth_error and sets no cookie", async () => {
    { const db = await makeTestDb();
      const cb = mockRes();
      await callbackHandler(deps(db))(mockReq({ query: { code: "abc", state: "garbage" } }) as any, cb as any);
      expect(cb._redirect).toContain("auth_error");
      expect(cb._headers["set-cookie"]).toBeUndefined();
    }
  });

  it("me returns the identity for a valid cookie + credentialed CORS for an allowed origin", async () => {
    { const db = await makeTestDb();
      const login = mockRes();
      await loginHandler(deps(db))(mockReq({ query: { return: "https://app.agentgem.ai" } }) as any, login as any);
      const state = new URL(login._redirect!).searchParams.get("state")!;
      const cb = mockRes();
      await callbackHandler(deps(db))(mockReq({ query: { code: "abc", state } }) as any, cb as any);
      const token = (cb._headers["set-cookie"] as string).split(";")[0].split("=")[1];

      const me = mockRes();
      await meHandler(deps(db))(mockReq({ headers: { cookie: `${SESSION_COOKIE}=${token}`, origin: "https://app.agentgem.ai" } }) as any, me as any);
      expect(me._body).toEqual({ login: "octocat", avatarUrl: null });
      expect(me._headers["access-control-allow-origin"]).toBe("https://app.agentgem.ai");
      expect(me._headers["access-control-allow-credentials"]).toBe("true");
    }
  });

  it("me returns unauthenticated without a cookie, and no CORS for a non-allowlisted origin", async () => {
    { const db = await makeTestDb();
      const me = mockRes();
      await meHandler(deps(db))(mockReq({ headers: { origin: "https://evil.example" } }) as any, me as any);
      expect(me._body).toEqual({ authenticated: false });
      expect(me._headers["access-control-allow-origin"]).toBeUndefined();
    }
  });

  it("answers an OPTIONS preflight with 204 + CORS for an allowed origin", async () => {
    { const db = await makeTestDb();
      const res = mockRes();
      await meHandler(deps(db))(mockReq({ method: "OPTIONS", headers: { origin: "https://app.agentgem.ai" } }) as any, res as any);
      expect(res._status).toBe(204);
      expect(res._headers["access-control-allow-origin"]).toBe("https://app.agentgem.ai");
      expect(res._headers["access-control-allow-credentials"]).toBe("true");
      expect(res._headers["access-control-allow-methods"]).toContain("OPTIONS");
    }
  });

  it("logout deletes the session and clears the cookie", async () => {
    { const db = await makeTestDb();
      const login = mockRes();
      await loginHandler(deps(db))(mockReq({ query: { return: "https://app.agentgem.ai" } }) as any, login as any);
      const state = new URL(login._redirect!).searchParams.get("state")!;
      const cb = mockRes();
      await callbackHandler(deps(db))(mockReq({ query: { code: "abc", state } }) as any, cb as any);
      const token = (cb._headers["set-cookie"] as string).split(";")[0].split("=")[1];

      const out = mockRes();
      await logoutHandler(deps(db))(mockReq({ method: "POST", headers: { cookie: `${SESSION_COOKIE}=${token}`, origin: "https://app.agentgem.ai" } }) as any, out as any);
      expect(out._body).toEqual({ ok: true });
      expect(await resolveSession(db, token)).toBeNull();
      expect(out._headers["set-cookie"]).toContain("Max-Age=0");
    }
  });
});
