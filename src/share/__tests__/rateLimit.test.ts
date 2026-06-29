import { describe, it, expect } from "vitest";
import { FixedWindowLimiter, clientIp, makeShareRateLimit } from "../rateLimit.js";

describe("FixedWindowLimiter", () => {
  it("allows up to max within the window, then blocks", () => {
    let now = 1000;
    const lim = new FixedWindowLimiter(3, 10_000, () => now);
    expect(lim.hit("a").allowed).toBe(true);
    expect(lim.hit("a").allowed).toBe(true);
    expect(lim.hit("a").allowed).toBe(true);
    const blocked = lim.hit("a");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(blocked.retryAfterMs).toBeLessThanOrEqual(10_000);
  });

  it("resets after the window elapses", () => {
    let now = 1000;
    const lim = new FixedWindowLimiter(1, 10_000, () => now);
    expect(lim.hit("a").allowed).toBe(true);
    expect(lim.hit("a").allowed).toBe(false);
    now = 11_001; // past the window
    expect(lim.hit("a").allowed).toBe(true);
  });

  it("tracks keys independently", () => {
    let now = 1000;
    const lim = new FixedWindowLimiter(1, 10_000, () => now);
    expect(lim.hit("a").allowed).toBe(true);
    expect(lim.hit("b").allowed).toBe(true); // different key, own budget
    expect(lim.hit("a").allowed).toBe(false);
  });
});

describe("clientIp", () => {
  const req = (headers: Record<string, string>, ip?: string) => ({
    get: (n: string) => headers[n.toLowerCase()],
    ip,
  });
  it("prefers CF-Connecting-IP", () => {
    expect(clientIp(req({ "cf-connecting-ip": "1.1.1.1", "x-forwarded-for": "2.2.2.2" }, "3.3.3.3"))).toBe("1.1.1.1");
  });
  it("falls back to the first X-Forwarded-For hop", () => {
    expect(clientIp(req({ "x-forwarded-for": "2.2.2.2, 9.9.9.9" }, "3.3.3.3"))).toBe("2.2.2.2");
  });
  it("falls back to req.ip", () => {
    expect(clientIp(req({}, "3.3.3.3"))).toBe("3.3.3.3");
  });
  it("returns 'unknown' when nothing is available", () => {
    expect(clientIp(req({}))).toBe("unknown");
  });
});

describe("makeShareRateLimit middleware", () => {
  function res() {
    const r: any = { code: 0, headers: {} as Record<string, string>, body: "" };
    r.status = (c: number) => { r.code = c; return r; };
    r.set = (n: string, v: string) => { r.headers[n] = v; return r; };
    r.type = () => r;
    r.send = (b: string) => { r.body = b; return r; };
    return r;
  }
  const post = (ip: string) => ({ method: "POST", path: "/api/aggregator/share", ip, get: () => undefined });

  it("passes through under the limit and blocks with 429 over it", () => {
    let now = 0;
    const mw = makeShareRateLimit({ max: 2, windowMs: 1000, now: () => now });
    let nexts = 0;
    const call = (r: any) => mw(post("5.5.5.5"), r, () => { nexts++; });
    call(res()); call(res());            // 2 allowed
    const blocked = res();
    call(blocked);                       // 3rd blocked
    expect(nexts).toBe(2);
    expect(blocked.code).toBe(429);
    expect(blocked.headers["Retry-After"]).toBeDefined();
  });

  it("ignores non-matching method/path", () => {
    const mw = makeShareRateLimit({ max: 1, windowMs: 1000, now: () => 0 });
    let nexts = 0;
    const r1 = res(); mw({ method: "GET", path: "/api/aggregator/share", ip: "x", get: () => undefined }, r1, () => nexts++);
    const r2 = res(); mw({ method: "POST", path: "/api/other", ip: "x", get: () => undefined }, r2, () => nexts++);
    const r3 = res(); mw({ method: "GET", path: "/api/aggregator/share", ip: "x", get: () => undefined }, r3, () => nexts++);
    expect(nexts).toBe(3); // none limited (GET + other path), even though max=1
  });
});
