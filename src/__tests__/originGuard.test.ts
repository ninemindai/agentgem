// src/__tests__/originGuard.test.ts
import { describe, it, expect } from "vitest";
import { originGuard } from "../originGuard.js";

// Drive originGuard with a duck-typed req/res and report whether it called next() or blocked (403).
function run(headers: Record<string, string | undefined>, host = "127.0.0.1:4317", method = "POST") {
  let nexted = false, blocked = false, status = 0;
  const req = { method, get: (n: string) => (n.toLowerCase() === "host" ? host : headers[n.toLowerCase()]) };
  const res = {
    status(c: number) { status = c; return res; },
    type() { return res; },
    send() { blocked = true; return res; },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  originGuard(req as any, res as any, () => { nexted = true; });
  return { nexted, blocked, status };
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
  it("blocks a malformed Origin", () => {
    expect(run({ origin: "not a url" }).blocked).toBe(true);
  });
});
