// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { setupRedirectHandler } from "../setupRedirect.js";

const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const cfg = { appId: "4226128", privateKey: pem, webhookSecret: "s" };

function mockRes() {
  const r: any = { _status: 0, _location: "" };
  r.redirect = (code: number, url: string) => { r._status = code; r._location = url; return r; };
  return r;
}
const req = (query: Record<string, unknown>) => ({ query }) as any;

// GET /app/installations/{id} fake: 144677036 → ninemindai org; 999 → 404.
const ghFetch = (async (url: string | URL) => {
  const u = String(url);
  if (u.endsWith("/app/installations/144677036")) {
    return { ok: true, status: 200, json: async () => ({ id: 144677036, account: { login: "NineMindAI", type: "Organization" } }) } as unknown as Response;
  }
  if (u.endsWith("/app/installations/777")) {
    return { ok: true, status: 200, json: async () => ({ id: 777, account: { login: "someuser", type: "User" } }) } as unknown as Response;
  }
  return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
}) as typeof fetch;

describe("GET /api/github/setup", () => {
  it("302s to the installing org's catalog page, lowercased, with installed=1", async () => {
    const res = mockRes();
    await setupRedirectHandler({ cfg, fetchImpl: ghFetch })(req({ installation_id: "144677036", setup_action: "install" }), res);
    expect(res._status).toBe(302);
    expect(res._location).toBe("https://app.agentgem.ai/orgs/ninemindai?installed=1");
  });

  it("falls back to the app home on unknown id, user-type install, garbage id, or missing id", async () => {
    for (const query of [{ installation_id: "999" }, { installation_id: "777" }, { installation_id: "abc" }, {}, { installation_id: "1".repeat(30) }]) {
      const res = mockRes();
      await setupRedirectHandler({ cfg, fetchImpl: ghFetch })(req(query), res);
      expect(res._status).toBe(302);
      expect(res._location).toBe("https://app.agentgem.ai/");
    }
  });

  it("falls back to the app home when the App is unconfigured (dormant contract)", async () => {
    const res = mockRes();
    await setupRedirectHandler({ cfg: null, fetchImpl: ghFetch })(req({ installation_id: "144677036" }), res);
    expect(res._status).toBe(302);
    expect(res._location).toBe("https://app.agentgem.ai/");
  });

  it("falls back to the app home when the GitHub lookup throws", async () => {
    const boom = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    const res = mockRes();
    await setupRedirectHandler({ cfg, fetchImpl: boom })(req({ installation_id: "144677036" }), res);
    expect(res._status).toBe(302);
    expect(res._location).toBe("https://app.agentgem.ai/");
  });
});
