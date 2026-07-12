// Cloudflare Worker fronting the marketplace's static assets. OPTIONAL acceleration only: it proxies
// the shareable entity paths (/games, /gems, /@handle, /skills) and /og/* to the aggregator's
// deployment-agnostic OG handler (env.OG_ORIGIN), so crawlers get a branded card. ONLY responses
// that carry a Cache-Control header (today just /og/card.png) are written to the edge cache; entity
// HTML is proxied UNCACHED by design (cheap to serve, and caching the SPA shell would risk stale
// hashed-asset references after a deploy). Everything else — and any error — falls through to
// env.ASSETS.fetch. Removing this Worker leaves cards working (uncached) straight from the origin.
// ZERO @agentgem imports by design.
//
// OG_ORIGIN MUST be the aggregator's own origin (e.g. https://api.agentgem.ai), never this worker's
// host (app.agentgem.ai) — proxying to our own host would loop.

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  OG_ORIGIN?: string;
}

// Mirrors packages/marketplace/src/Router.tsx entity shapes + the /og image route.
const OG_INTERCEPT = [/^\/games\/.+$/, /^\/gems\/.+$/, /^\/@[^/]+$/, /^\/skills\/[^/]+\/.+$/, /^\/og\/.+$/];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const intercept = request.method === "GET" && !!env.OG_ORIGIN && OG_INTERCEPT.some((re) => re.test(url.pathname));
    if (!intercept) return env.ASSETS.fetch(request);

    const cache = (caches as unknown as { default: Cache }).default;
    const cacheKey = new Request(url.toString(), { method: "GET" });
    try {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
      const origin = `${env.OG_ORIGIN}${url.pathname}${url.search}`;
      const res = await fetch(origin, { headers: { "user-agent": request.headers.get("user-agent") ?? "" } });
      if (!res.ok) return env.ASSETS.fetch(request);
      // body is the DECODED bytes; drop the origin's content-encoding/content-length so the runtime
      // re-derives them from the actual body (a stale content-encoding would mislabel decoded bytes,
      // and a stale content-length would truncate — the same corruption the old worker guarded).
      const body = await res.arrayBuffer();
      const headers = new Headers(res.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      const out = new Response(body, { status: res.status, headers });
      if (headers.get("cache-control")) await cache.put(cacheKey, out.clone());
      return out;
    } catch {
      return env.ASSETS.fetch(request);
    }
  },
};
