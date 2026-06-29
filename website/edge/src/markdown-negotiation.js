import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";   // wrangler -> WebAssembly.Module
import cardFont from "../assets/card-font.ttf";            // wrangler Data rule -> bytes
import { initRaster } from "./raster.js";
import { handleShare } from "./share.js";
// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// agentgem.ai served from Cloudflare Workers Static Assets, with markdown
// content negotiation. Alias hosts (agentgem.ninemind.ai, agentgem.dev) are
// attached to this Worker as Custom Domains and 301-redirected to agentgem.ai.
//
// The build (website/build.mjs → website/dist) emits an authored `.md` twin
// next to every docs page plus `/llms.txt` and `/llms-full.txt`. Cloudflare
// uploads `dist` as the Worker's static assets (the `ASSETS` binding); this
// Worker serves them and, when an agent sends `Accept: text/markdown`, returns
// the authored markdown twin instead of the HTML — a *local* asset lookup, no
// origin and no cross-origin fetch.
//
// Fail-safe: any error, or any path without a markdown twin, serves the normal
// asset. The Worker fronts the whole site, so it must never break it.

/**
 * Map a request path to its authored markdown twin, or null if the path is not
 * a negotiable HTML document (assets, already-markdown, etc.).
 * @param {string} pathname
 * @returns {string | null}
 */
export function markdownTwin(pathname) {
  let p = pathname;
  if (p === '/') return null; // homepage is hand-authored HTML with no .md twin
  if (p.endsWith('/')) p += 'index.html'; // directory → its index document
  if (p.endsWith('.html')) return `${p.slice(0, -'.html'.length)}.md`;
  // Extensionless paths resolve to `<path>.html` as static assets.
  const last = p.slice(p.lastIndexOf('/') + 1);
  if (!last.includes('.')) return `${p}.md`;
  return null; // has a non-HTML extension (.png, .css, .json, …)
}

async function serveMarkdown(request, env) {
  const url = new URL(request.url);
  const twin = markdownTwin(url.pathname);
  if (!twin) return null;

  const twinUrl = new URL(url);
  twinUrl.pathname = twin;
  twinUrl.search = '';

  // Read the twin straight from the uploaded asset set — no network hop.
  const asset = await env.ASSETS.fetch(
    new Request(twinUrl.toString(), {headers: {Accept: 'text/plain, */*'}}),
  );
  if (!asset.ok) return null; // no twin on disk → let the HTML asset serve

  const headers = new Headers();
  headers.set('Content-Type', 'text/markdown; charset=utf-8');
  headers.set('Vary', 'Accept');
  headers.set('Cache-Control', 'public, max-age=300');
  headers.set('X-Content-Negotiation', 'agentgem-markdown');
  return new Response(asset.body, {status: 200, headers});
}

// The one canonical host. Every alias Custom Domain on this Worker redirects
// here, so the canonical URL lives in exactly one place.
const CANONICAL_HOST = 'agentgem.ai';

export default {
  async fetch(request, env) {
    // 301 any alias host (agentgem.ninemind.ai, agentgem.dev, …) to the
    // canonical host, preserving path + query. The aliases hit this Worker
    // because they are attached as Custom Domains.
    const url = new URL(request.url);
    if (url.hostname !== CANONICAL_HOST) {
      url.hostname = CANONICAL_HOST;
      url.protocol = 'https:';
      url.port = '';
      return Response.redirect(url.toString(), 301);
    }

    try {
      await initRaster({ wasm: resvgWasm, font: cardFont });
      const shared = await handleShare(request, env);
      if (shared) return shared;
    } catch (e) {
      console.error("share route error:", e);
      // Never let sharing break the site — fall through to assets.
    }

    try {
      if (request.method === 'GET') {
        const accept = (request.headers.get('Accept') || '').toLowerCase();
        if (accept.includes('text/markdown')) {
          const md = await serveMarkdown(request, env);
          if (md) return md;
        }
      }
    } catch {
      // Never let negotiation break the site — fall through to the asset.
    }
    return env.ASSETS.fetch(request);
  },
};
