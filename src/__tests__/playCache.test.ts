// src/__tests__/playCache.test.ts
import { describe, it, expect } from "vitest";
import { playNoCache } from "../playCache.js";

// Duck-typed req/res, mirroring originGuard.test.ts: report the headers set and whether next() ran.
function run(method = "GET", path = "/api/play/miniapp") {
  let nexted = false;
  const set: Record<string, string> = {};
  const req = { method, path };
  const res = { set(k: string, v: string) { set[k.toLowerCase()] = v; return res; } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  playNoCache(req as any, res as any, () => { nexted = true; });
  return { nexted, cacheControl: set["cache-control"] };
}

describe("playNoCache", () => {
  // Express sends an ETag but no Cache-Control. A bare ETag lets the browser apply *heuristic*
  // freshness and serve a cached body without revalidating — so the Studio can render html the
  // agent already replaced on disk.
  it("marks the miniapp html read no-cache so the browser revalidates", () => {
    expect(run("GET", "/api/play/miniapp").cacheControl).toBe("no-cache");
  });

  it("covers every mutable local read under /api/play", () => {
    for (const p of ["/api/play/miniapp", "/api/play/miniapps", "/api/play/mcp-app", "/api/play/session-data"]) {
      expect(run("GET", p).cacheControl, p).toBe("no-cache");
    }
  });

  // no-cache, never no-store: the ETag still answers 304, so revalidation costs a conditional
  // request rather than re-downloading ~19KB of html on every mount.
  it("does not use no-store", () => {
    expect(run("GET", "/api/play/miniapp").cacheControl).not.toContain("no-store");
  });

  it("leaves unrelated routes alone", () => {
    expect(run("GET", "/api/inventory").cacheControl).toBeUndefined();
    expect(run("GET", "/api/play/miniapp/extra").cacheControl).toBeUndefined(); // exact-match, no prefix
  });

  it("ignores writes — POST /play/save must not be marked", () => {
    expect(run("POST", "/api/play/miniapp").cacheControl).toBeUndefined();
  });

  it("always calls next()", () => {
    expect(run("GET", "/api/play/miniapp").nexted).toBe(true);
    expect(run("GET", "/api/inventory").nexted).toBe(true);
  });
});
