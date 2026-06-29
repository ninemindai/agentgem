import { describe, it, expect, afterEach } from "vitest";
import { requireShareOriginSecret } from "../../originSecret.js";

function res() {
  const r: any = { code: 0, body: "" };
  r.status = (c: number) => { r.code = c; return r; };
  r.type = () => r;
  r.send = (b: string) => { r.body = b; return r; };
  return r;
}
const req = (method: string, path: string, headers: Record<string, string> = {}) => ({
  method, path, get: (n: string) => headers[n.toLowerCase()],
});

afterEach(() => { delete process.env.ORIGIN_SHARED_SECRET; });

describe("requireShareOriginSecret", () => {
  it("is a no-op when ORIGIN_SHARED_SECRET is unset (local/dev)", () => {
    delete process.env.ORIGIN_SHARED_SECRET;
    let nexts = 0;
    const r = res();
    requireShareOriginSecret(req("POST", "/api/aggregator/share"), r, () => nexts++);
    expect(nexts).toBe(1);
    expect(r.code).toBe(0);
  });

  it("allows the create POST when the secret header matches", () => {
    process.env.ORIGIN_SHARED_SECRET = "s3cr3t-value";
    let nexts = 0;
    const r = res();
    requireShareOriginSecret(req("POST", "/api/aggregator/share", { "x-origin-auth": "s3cr3t-value" }), r, () => nexts++);
    expect(nexts).toBe(1);
    expect(r.code).toBe(0);
  });

  it("403s the create POST when the header is missing or wrong", () => {
    process.env.ORIGIN_SHARED_SECRET = "s3cr3t-value";
    const missing = res();
    requireShareOriginSecret(req("POST", "/api/aggregator/share"), missing, () => { throw new Error("should not pass"); });
    expect(missing.code).toBe(403);
    const wrong = res();
    requireShareOriginSecret(req("POST", "/api/aggregator/share", { "x-origin-auth": "nope" }), wrong, () => { throw new Error("should not pass"); });
    expect(wrong.code).toBe(403);
  });

  it("never gates non-create traffic (reads, healthz, other methods) even with the secret set", () => {
    process.env.ORIGIN_SHARED_SECRET = "s3cr3t-value";
    let nexts = 0;
    const pass = (m: string, p: string) => requireShareOriginSecret(req(m, p), res(), () => nexts++);
    pass("GET", "/api/aggregator/share");        // read by id
    pass("GET", "/api/aggregator/popularity");   // public read
    pass("POST", "/api/aggregator/ingest");      // own gating bucket
    pass("GET", "/healthz");                      // Render probe
    expect(nexts).toBe(4);
  });
});
