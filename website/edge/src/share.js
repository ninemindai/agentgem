// Public certificate share routes. /share/:id -> OG HTML; /share/:id/og.png ->
// rasterized card. Data comes from the hosted aggregator (env.AGGREGATOR_API).
// When AGGREGATOR_API is unset the route degrades to a placeholder so the Worker
// never breaks the site before the backend is deployed (#38).
import { cardDescription } from "./card.js";
import { rasterizeCard } from "./raster.js";

const CANONICAL = "https://agentgem.ai";

export function parseShareId(pathname) {
  const m = pathname.match(/^\/share\/([A-Za-z0-9]+)(\/og\.png)?$/);
  if (!m) return null;
  return { id: m[1], png: Boolean(m[2]) };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function placeholderHtml() {
  return `<!doctype html><meta charset="utf-8"><title>AgentGem</title>` +
    `<body style="font-family:sans-serif;background:#0b0f17;color:#e8edf5;padding:48px">` +
    `<h1>Sharing is coming soon</h1><p><a style="color:#7cc4ff" href="${CANONICAL}">Value your own agent goldmine →</a></p></body>`;
}

export function renderGemShareHtml(record, { shareUrl }) {
  const name = esc(record.name), prov = esc(record.provenance);
  return `<!doctype html><html><head><meta charset="utf-8">` +
    `<title>${name} — AgentGem</title>` +
    `<meta property="og:title" content="${name}">` +
    `<meta property="og:description" content="${prov}">` +
    `<meta property="og:type" content="website">` +
    `<meta property="og:url" content="${esc(shareUrl)}">` +
    `<meta name="twitter:card" content="summary">` +
    `<meta name="twitter:title" content="${name}">` +
    `<meta name="twitter:description" content="${prov}">` +
    `</head><body style="font-family:sans-serif;background:#0b0f17;color:#e8edf5;text-align:center;padding:48px">` +
    `<h1 style="font-size:34px;margin:0 0 8px">${name}</h1>` +
    `<p style="font-size:18px;color:#9aa">${prov}</p>` +
    `<p><a style="color:#7cc4ff;font-size:22px" href="${CANONICAL}">Value your own agent goldmine →</a></p>` +
    `</body></html>`;
}

export function renderShareHtml(record, { ogImageUrl, shareUrl }) {
  const desc = cardDescription(record.counts);
  return `<!doctype html><html><head><meta charset="utf-8">` +
    `<title>My Agent Goldmine — AgentGem</title>` +
    `<meta property="og:title" content="My Agent Goldmine">` +
    `<meta property="og:description" content="${esc(desc)}">` +
    `<meta property="og:type" content="website">` +
    `<meta property="og:url" content="${esc(shareUrl)}">` +
    `<meta property="og:image" content="${esc(ogImageUrl)}">` +
    `<meta name="twitter:card" content="summary_large_image">` +
    `<meta name="twitter:title" content="My Agent Goldmine">` +
    `<meta name="twitter:description" content="${esc(desc)}">` +
    `<meta name="twitter:image" content="${esc(ogImageUrl)}">` +
    `</head><body style="font-family:sans-serif;background:#0b0f17;color:#e8edf5;text-align:center;padding:48px">` +
    `<img src="${esc(ogImageUrl)}" alt="${esc(desc)}" width="600" style="max-width:100%;border-radius:12px">` +
    `<p style="font-size:20px">${esc(desc)}</p>` +
    `<p><a style="color:#7cc4ff;font-size:22px" href="${CANONICAL}">Value your own agent goldmine →</a></p>` +
    `</body></html>`;
}

// Edge-cacheable responses are exactly the ones that carry a Cache-Control header — the rendered
// HTML (max-age=300) and og.png (immutable). The placeholder and the 404 set none, so they are
// never cached (the placeholder must stop serving the moment the backend is wired).
export function isCacheable(res) {
  return Boolean(res && res.headers && res.headers.get && res.headers.get("cache-control"));
}

async function fetchRecord(env, id) {
  const f = env.fetch || fetch;
  const res = await f(`${env.AGGREGATOR_API}/api/aggregator/share?id=${encodeURIComponent(id)}`);
  if (!res.ok) return null;
  return res.json();
}

export async function handleShare(request, env) {
  if (request.method !== "GET") return null;
  const url = new URL(request.url);
  const parsed = parseShareId(url.pathname);
  if (!parsed) return null;

  if (!env.AGGREGATOR_API) {
    return new Response(placeholderHtml(), { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  }

  const record = await fetchRecord(env, parsed.id);
  if (!record) {
    return new Response("Card not found", { status: 404, headers: { "content-type": "text/plain" } });
  }

  if (record.kind === "gem") {
    if (parsed.png) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
    const shareUrl = `${CANONICAL}/share/${parsed.id}`;
    const html = renderGemShareHtml(record, { shareUrl });
    return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" } });
  }

  if (parsed.png) {
    const png = await rasterizeCard(record.counts);
    return new Response(png, { status: 200, headers: { "content-type": "image/png", "cache-control": "public, max-age=31536000, immutable" } });
  }

  const shareUrl = `${CANONICAL}/share/${parsed.id}`;
  const html = renderShareHtml(record, { ogImageUrl: `${shareUrl}/og.png`, shareUrl });
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" } });
}
