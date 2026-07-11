// Cloudflare Worker in front of the marketplace's static assets. Its ONLY job is to give a
// /games/<key> link a title/description unfurl (a summary card, no image) by injecting og:* meta
// into the SPA shell's <head>; the full SPA body is preserved so React still hydrates and plays.
//
// run_worker_first (wrangler.jsonc) runs this on EVERY request to app.agentgem.ai, so the
// overriding rule is: fall through to env.ASSETS.fetch(request) for anything that isn't a
// GET /games/<key> we can enrich, and on ANY error. A worker bug must never take down the site.
//
// Mirrors website/edge/src/share.js's renderGemShareHtml + esc(), but injects into the shell
// rather than replacing the document.

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  AGGREGATOR_API?: string;
}

const GAMES = /^\/games\/(.+)$/;
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

function ogTags(title: string, url: string): string {
  const t = esc(title), u = esc(url);
  return (
    `<meta property="og:title" content="${t}">` +
    `<meta property="og:description" content="Play ${t} on AgentGem">` +
    `<meta property="og:type" content="website">` +
    `<meta property="og:url" content="${u}">` +
    `<meta name="twitter:card" content="summary">` +
    `<meta name="twitter:title" content="${t}">` +
    `<meta name="twitter:description" content="Play ${t} on AgentGem">`
  );
}

// Inject the tags just before </head>, and replace the static <title>AgentGem</title> so the tab +
// unfurl title match the game. String ops only (the shell is tiny and stable); no HTML parser.
function injectHead(html: string, title: string, url: string): string {
  return html
    .replace(/<title>[^<]*<\/title>/i, `<title>${esc(title)} — AgentGem</title>`)
    .replace(/<\/head>/i, `${ogTags(title, url)}</head>`);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const m = request.method === "GET" ? url.pathname.match(GAMES) : null;
    if (!m || !env.AGGREGATOR_API) return env.ASSETS.fetch(request);

    try {
      const key = m[1];   // raw (matches Play.tsx's greedy parse); the API takes it as a query param
      const metaRes = await fetch(`${env.AGGREGATOR_API}/api/aggregator/game-meta?key=${encodeURIComponent(key)}`);
      if (!metaRes.ok) return env.ASSETS.fetch(request);
      const meta = (await metaRes.json()) as { title?: unknown };
      if (typeof meta.title !== "string") return env.ASSETS.fetch(request);

      const assetRes = await env.ASSETS.fetch(request);
      const html = await assetRes.text();
      const out = injectHead(html, meta.title, url.toString());
      // Preserve the asset response's headers/status, but DROP content-length: the injected body
      // is longer than the shell, and a stale content-length would truncate the response.
      const headers = new Headers(assetRes.headers);
      headers.delete("content-length");
      return new Response(out, { status: assetRes.status, headers });
    } catch {
      return env.ASSETS.fetch(request);   // any failure → the unmodified SPA
    }
  },
};
