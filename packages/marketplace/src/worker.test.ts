import { describe, it, expect, vi, beforeEach } from "vitest";
import worker from "./worker";

// The Worker uses the Cloudflare Cache API (caches.default), absent in the vitest env — stub it.
beforeEach(() => {
  const store = new Map<string, Response>();
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

  it("proxies /og/card.png to OG_ORIGIN", async () => {
    const e = env();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("PNGBYTES", { status: 200, headers: { "content-type": "image/png" } }));
    await worker.fetch(new Request("https://app.agentgem.ai/og/card.png?type=game&key=x"), e as never);
    expect(fetchSpy).toHaveBeenCalledWith("https://api.agentgem.ai/og/card.png?type=game&key=x", expect.anything());
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
