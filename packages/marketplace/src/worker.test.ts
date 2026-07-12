import { describe, it, expect, vi, beforeEach } from "vitest";
import worker from "./worker";

// The Worker uses the Cloudflare Cache API (caches.default), absent in the vitest env — stub it.
// `store` is exposed so a test can pre-seed a cache HIT (worker returns it without hitting origin).
let store: Map<string, Response>;
beforeEach(() => {
  store = new Map<string, Response>();
  (globalThis as unknown as { caches: { default: Cache } }).caches = {
    default: {
      match: async (k: Request) => store.get(k.url),
      put: async (k: Request, v: Response) => { store.set(k.url, v); },
    },
  } as unknown as { default: Cache };
});

function env(overrides: Partial<{ OG_ORIGIN: string; assets: string }> = {}) {
  return {
    OG_ORIGIN: overrides.OG_ORIGIN ?? "https://api.agentgem.ai",
    ASSETS: { fetch: vi.fn(async () => new Response(overrides.assets ?? "<html>SPA</html>", { status: 200, headers: { "content-type": "text/html" } })) },
  };
}

describe("marketplace worker (proxy+cache shim)", () => {
  it("proxies an entity path to OG_ORIGIN and returns the enriched HTML", async () => {
    const e = env();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>CARD</html>", { status: 200, headers: { "content-type": "text/html" } }));
    const res = await worker.fetch(new Request("https://app.agentgem.ai/games/@acme/pizza"), e as never);
    expect(fetchSpy).toHaveBeenCalledWith("https://api.agentgem.ai/games/@acme/pizza", expect.anything());
    expect(await res.text()).toBe("<html>CARD</html>");
    expect(e.ASSETS.fetch).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("proxies /og/card.png to OG_ORIGIN and strips stale content-encoding/-length", async () => {
    const e = env();
    // Origin returns DECODED bytes but stale content-encoding/-length headers (as would happen if
    // anything compressed between worker and aggregator); the worker must drop both so the runtime
    // re-derives them from the actual body.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("PNGBYTES", { status: 200, headers: { "content-type": "image/png", "content-encoding": "gzip", "content-length": "999" } }));
    const res = await worker.fetch(new Request("https://app.agentgem.ai/og/card.png?type=game&key=x"), e as never);
    expect(fetchSpy).toHaveBeenCalledWith("https://api.agentgem.ai/og/card.png?type=game&key=x", expect.anything());
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("content-length")).toBeNull();
    fetchSpy.mockRestore();
  });

  it("returns a cached hit WITHOUT hitting the origin", async () => {
    const e = env();
    const url = "https://app.agentgem.ai/og/card.png?type=game&key=cached";
    store.set(url, new Response("CACHED-PNG", { status: 200, headers: { "content-type": "image/png" } }));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await worker.fetch(new Request(url), e as never);
    expect(await res.text()).toBe("CACHED-PNG");
    expect(fetchSpy).not.toHaveBeenCalled();       // cache hit short-circuits the origin proxy
    expect(e.ASSETS.fetch).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("falls through to ASSETS for a non-entity path", async () => {
    const e = env();
    await worker.fetch(new Request("https://app.agentgem.ai/gems"), e as never);
    expect(e.ASSETS.fetch).toHaveBeenCalled();
  });

  it("falls through to ASSETS when the origin proxy fails", async () => {
    const e = env();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("down"));
    await worker.fetch(new Request("https://app.agentgem.ai/games/@acme/x"), e as never);
    expect(e.ASSETS.fetch).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
