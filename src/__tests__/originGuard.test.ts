// src/__tests__/originGuard.test.ts
import { describe, it, expect } from "vitest";
import { originGuard } from "../originGuard.js";

// Drive originGuard with a duck-typed req/res and report what it did: called next(), set a header,
// or sent a status. `blocked` keeps its old meaning (a 403 was sent) for the existing cases.
function run(
  headers: Record<string, string | undefined>,
  host = "127.0.0.1:4317",
  method = "POST",
  path = "/api/gem",
) {
  let nexted = false, status = 0, sent = false;
  const set: Record<string, string> = {};
  const req = { method, path, get: (n: string) => (n.toLowerCase() === "host" ? host : headers[n.toLowerCase()]) };
  const res = {
    status(c: number) { status = c; return res; },
    type() { return res; },
    send() { sent = true; return res; },
    set(k: string, v: string) { set[k.toLowerCase()] = v; return res; },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  originGuard(req as any, res as any, () => { nexted = true; });
  return { nexted, status, sent, set, blocked: sent && status === 403 };
}

describe("originGuard (CSRF / drive-by guard)", () => {
  it("allows same-origin browser requests (Sec-Fetch-Site: same-origin)", () => {
    expect(run({ "sec-fetch-site": "same-origin" }).nexted).toBe(true);
  });
  it("allows a direct navigation GET (Sec-Fetch-Site: none, safe method)", () => {
    expect(run({ "sec-fetch-site": "none" }, "127.0.0.1:4317", "GET").nexted).toBe(true);
  });
  it("blocks a state-changing POST claiming Sec-Fetch-Site: none (form/navigation drive-by)", () => {
    const r = run({ "sec-fetch-site": "none" }, "127.0.0.1:4317", "POST");
    expect(r.blocked).toBe(true);
    expect(r.status).toBe(403);
  });
  it("blocks cross-site browser requests (Sec-Fetch-Site: cross-site)", () => {
    const r = run({ "sec-fetch-site": "cross-site" });
    expect(r.blocked).toBe(true);
    expect(r.status).toBe(403);
  });
  it("blocks same-site-but-cross-origin requests (Sec-Fetch-Site: same-site)", () => {
    expect(run({ "sec-fetch-site": "same-site" }).blocked).toBe(true);
  });
  it("allows non-browser clients (no Sec-Fetch-Site, no Origin) — CLI/curl/MCP/tests", () => {
    expect(run({}).nexted).toBe(true);
  });
  it("allows an Origin matching the Host (fallback for browsers without Sec-Fetch-Site)", () => {
    expect(run({ origin: "http://127.0.0.1:4317" }, "127.0.0.1:4317").nexted).toBe(true);
  });
  it("blocks an Origin that does not match the Host", () => {
    const r = run({ origin: "http://evil.example" }, "127.0.0.1:4317");
    expect(r.blocked).toBe(true);
    expect(r.status).toBe(403);
  });
  it("allows cross-site web sign-in requests (/api/auth/*) — OAuth nav + the SPA's credentialed XHR", () => {
    // The real sign-in flow is cross-site: clicking "Sign in" on explore.agentgem.ai navigates to
    // app.agentgem.ai/api/auth/github/login (Sec-Fetch-Site: cross-site), GitHub redirects to the
    // callback (cross-site), and /me + /logout are credentialed XHR. originGuard must not block these.
    expect(run({ "sec-fetch-site": "cross-site" }, "app.agentgem.ai", "GET", "/api/auth/github/login").nexted).toBe(true);
    expect(run({ "sec-fetch-site": "cross-site" }, "app.agentgem.ai", "GET", "/api/auth/github/callback").nexted).toBe(true);
    expect(run({ "sec-fetch-site": "cross-site" }, "app.agentgem.ai", "GET", "/api/auth/me").nexted).toBe(true);
    expect(run({ "sec-fetch-site": "cross-site" }, "app.agentgem.ai", "POST", "/api/auth/logout").nexted).toBe(true);
  });
  it("still blocks a cross-site request to a NON-auth API path", () => {
    expect(run({ "sec-fetch-site": "cross-site" }, "app.agentgem.ai", "POST", "/api/gem").blocked).toBe(true);
  });
  it("allows cross-site star requests (/api/stars + /api/stars/toggle) — public counts + the SPA's credentialed toggle", () => {
    expect(run({ "sec-fetch-site": "cross-site" }, "app.agentgem.ai", "GET", "/api/stars").nexted).toBe(true);
    expect(run({ "sec-fetch-site": "cross-site" }, "app.agentgem.ai", "POST", "/api/stars/toggle").nexted).toBe(true);
  });
  it("blocks a malformed Origin", () => {
    expect(run({ origin: "not a url" }).blocked).toBe(true);
  });
});

describe("originGuard — public aggregator reads (CORS + cross-site exemption)", () => {
  const POP = "/api/aggregator/popularity";
  const CO = "/api/aggregator/co-occurrence";

  it("allows a cross-site GET to popularity and sets permissive CORS", () => {
    const r = run({ "sec-fetch-site": "cross-site" }, "agg.example", "GET", POP);
    expect(r.nexted).toBe(true);
    expect(r.blocked).toBe(false);
    expect(r.set["access-control-allow-origin"]).toBe("*");
  });
  it("allows a cross-site GET to co-occurrence and sets permissive CORS", () => {
    const r = run({ "sec-fetch-site": "cross-site" }, "agg.example", "GET", CO);
    expect(r.nexted).toBe(true);
    expect(r.set["access-control-allow-origin"]).toBe("*");
  });
  it("allows a cross-site GET to adoption and sets permissive CORS", () => {
    const r = run({ "sec-fetch-site": "cross-site" }, "agg.example", "GET", "/api/aggregator/adoption");
    expect(r.nexted).toBe(true);
    expect(r.set["access-control-allow-origin"]).toBe("*");
  });
  it("answers an OPTIONS preflight to a public read with 204 + CORS, without dispatching the route", () => {
    const r = run({ "sec-fetch-site": "cross-site", "access-control-request-method": "GET" }, "agg.example", "OPTIONS", POP);
    expect(r.status).toBe(204);
    expect(r.set["access-control-allow-origin"]).toBe("*");
    expect(r.set["access-control-allow-methods"]).toContain("GET");
    expect(r.nexted).toBe(false); // short-circuits; never reaches the controller
  });
  it("does NOT exempt a protected read — cross-site GET to /api/inventory is still blocked, no CORS", () => {
    const r = run({ "sec-fetch-site": "cross-site" }, "127.0.0.1:4317", "GET", "/api/inventory");
    expect(r.blocked).toBe(true);
    expect(r.status).toBe(403);
    expect(r.set["access-control-allow-origin"]).toBeUndefined();
  });
  it("does NOT exempt the ingest write — cross-site POST to /api/aggregator/ingest stays guarded", () => {
    const r = run({ "sec-fetch-site": "cross-site" }, "agg.example", "POST", "/api/aggregator/ingest");
    expect(r.blocked).toBe(true);
    expect(r.status).toBe(403);
  });
  it("does NOT exempt a POST to a public-read path (only safe methods are public)", () => {
    const r = run({ "sec-fetch-site": "cross-site" }, "agg.example", "POST", POP);
    expect(r.blocked).toBe(true);
  });
  it("still serves the public read to a same-origin caller", () => {
    const r = run({ "sec-fetch-site": "same-origin" }, "agg.example", "GET", POP);
    expect(r.nexted).toBe(true);
  });
  it("allows a cross-site GET to co-occurrence-matrix and sets permissive CORS", () => {
    const r = run({ "sec-fetch-site": "cross-site" }, "agg.example", "GET", "/api/aggregator/co-occurrence-matrix");
    expect(r.nexted).toBe(true);
    expect(r.set["access-control-allow-origin"]).toBe("*");
  });
  it("does NOT exempt the bind write — cross-site POST to /api/aggregator/bind stays guarded", () => {
    const r = run({ "sec-fetch-site": "cross-site" }, "agg.example", "POST", "/api/aggregator/bind");
    expect(r.blocked).toBe(true);
    expect(r.status).toBe(403);
  });

  it("allows a cross-site GET to the public gem catalog and sets permissive CORS", () => {
    const r = run({ "sec-fetch-site": "cross-site" }, "agg.example", "GET", "/api/registry/gems");
    expect(r.nexted).toBe(true);
    expect(r.set["access-control-allow-origin"]).toBe("*");
  });
});
