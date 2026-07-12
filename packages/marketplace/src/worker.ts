// Cloudflare Worker fronting the marketplace's static assets. OPTIONAL acceleration only: it proxies
// the shareable entity paths (/games, /gems, /@handle, /skills) and /og/* to the aggregator's
// deployment-agnostic OG handler (env.OG_ORIGIN) with edge caching, so crawlers get a branded card.
// Everything else — and any error — falls through to env.ASSETS.fetch. Removing this Worker leaves
// cards working (uncached) straight from the origin. ZERO @agentgem imports by design.
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
      const body = await res.arrayBuffer();
      const out = new Response(body, { status: res.status, headers: res.headers });
      if (res.headers.get("cache-control")) await cache.put(cacheKey, out.clone());
      return out;
    } catch {
      return env.ASSETS.fetch(request);
    }
  },
};
