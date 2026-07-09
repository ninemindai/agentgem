// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../../index.js";
import { mountAuth } from "../mount.js";

const ORIGINS = ["https://app.agentgem.ai"];

// A stub "auth" whose handler(request) proves two things the real mountAuth must get right:
// 1) the JSON body survives past the app's global express.json() (which drains the stream before
//    mountAuth's handler ever sees req), by echoing back whatever body it received.
// 2) two Set-Cookie headers arrive on the wire SEPARATELY, not coalesced into one comma-joined
//    (invalid) string — Fetch's Headers class coalesces same-name headers by default except
//    Set-Cookie, which getSetCookie() exposes as a proper array.
function stubAuth() {
  return {
    handler: async (req: Request) => {
      const body = ["GET", "HEAD"].includes(req.method) ? null : await req.json().catch(() => null);
      const headers = new Headers({ "content-type": "application/json" });
      headers.append("set-cookie", "a=1; Path=/; HttpOnly");
      headers.append("set-cookie", "b=2; Path=/; HttpOnly");
      return new Response(JSON.stringify({ echoed: body }), { status: 200, headers });
    },
  } as never;
}

// Reuse the real server's expressApp (built by createApp) rather than a bespoke express()
// instance — it carries the SAME global express.json() the production app registers (25mb
// limit + webhook `verify`), so a passing test here proves the body survives past that exact
// middleware, not just some idealized stand-in.
async function buildApp() {
  const app = await createApp(0);
  const server = await app.restServer;
  mountAuth(server.expressApp as never, stubAuth(), ORIGINS, "/api/betterauth");
  return server.expressApp;
}

describe("mountAuth", () => {
  it("a real POST with a JSON body reaches the stub non-empty (body survives express.json())", async () => {
    const app = await buildApp();
    const res = await request(app).post("/api/betterauth/sign-in").send({ email: "a@b.com" });
    expect(res.status).toBe(200);
    expect(res.body.echoed).toEqual({ email: "a@b.com" });
  });

  it("both Set-Cookie headers arrive separately, not coalesced", async () => {
    const app = await buildApp();
    const res = await request(app).post("/api/betterauth/sign-in").send({});
    const cookies = res.headers["set-cookie"] as unknown as string[];
    expect(Array.isArray(cookies)).toBe(true);
    expect(cookies).toHaveLength(2);
    expect(cookies.some((c) => c.startsWith("a=1"))).toBe(true);
    expect(cookies.some((c) => c.startsWith("b=2"))).toBe(true);
  });

  it("OPTIONS from an allowlisted origin -> 204 with credentialed CORS", async () => {
    const app = await buildApp();
    const res = await request(app).options("/api/betterauth/sign-in").set("Origin", "https://app.agentgem.ai");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("https://app.agentgem.ai");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("a foreign origin gets no ACAO header", async () => {
    const app = await buildApp();
    const res = await request(app).post("/api/betterauth/sign-in").set("Origin", "https://evil.example").send({});
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
