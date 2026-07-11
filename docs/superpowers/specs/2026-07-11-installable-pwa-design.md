# Installable PWAs — local console + `app.agentgem.ai`

**Date:** 2026-07-11
**Status:** Approved (design)

## Goal

Make both of AgentGem's web front-ends installable as apps in Chrome (and other
Chromium browsers) — Chrome's "Install app" affordance opens the page in its own
standalone window with a dock/taskbar icon and no browser chrome.

Scope is **installable only**: a web app manifest + icons + `<link>` tags. **No
service worker, no offline support.** Both apps are clients of a server
(the local `127.0.0.1` server for the console; `api.agentgem.ai` for the
marketplace) and have no useful function without it, so an offline shell would
open to a wall of API errors — added complexity, no benefit.

This is distinct from the existing Electron desktop app: the PWA is a
lightweight install path for users who already run the local server and open
`localhost` in Chrome.

## Installability criteria (why this works)

Chromium offers install when the page is a **secure context** and has a valid
manifest with **192px and 512px icons**, a `start_url`, and
`display: standalone` (or `fullscreen`/`minimal-ui`). `localhost` is a secure
context, so the local console qualifies without HTTPS; the marketplace is served
over real HTTPS by Cloudflare.

## Two targets, two mechanics

The two front-ends are separate codebases with separate build systems and deploy
paths, so they ship as **two independent PRs**.

### Target A — Local console (`packages/console`, esbuild → single file)

The console is deliberately built as **one self-contained `index.html`**
(`build-client.mjs` inlines all JS + CSS), served by the local server with a
single `readFileSync` route. To preserve that "one route per file" ethos, the
icons are **inlined as `data:` PNG URIs inside the manifest JSON** rather than
served as separate icon files. Net new served file count: **one** (the
manifest), not a pile of icon routes.

Changes:

1. **`packages/console/src/pwa/icons.ts`** (new) — exports the three icon PNGs as
   base64 `data:` URI string constants (192, 512, 512-maskable). Generated once
   from the gem-mark artwork (see *Icons*); committed, so there is **no new build
   or runtime dependency** (no rasterizer at build time).

2. **`packages/console/build-client.mjs`** — in addition to `dist/index.html`,
   assemble and write **`dist/manifest.webmanifest`**, a JSON blob whose `icons`
   entries reference the `data:` URIs from `icons.ts`. Also extend the HTML
   `<head>` with:
   - `<link rel="manifest" href="/manifest.webmanifest">`
   - `<meta name="theme-color" content="#f1eadb">`
   - `<link rel="apple-touch-icon" href="<192 data URI>">`

3. **`scripts/build-console.mjs`** — copy `dist/manifest.webmanifest` into
   `dist/public/console/` alongside `index.html`, so both the packaged
   `files:["dist"]` npm layout and the desktop bundle's `cpSync dist/public`
   pick it up. Its test (`scripts/__tests__/build-console.test.mjs`) gains an
   assertion that the manifest is present.

4. **`src/index.ts`** — inside the existing `if (process.env.SERVE_CONSOLE !==
   "false")` block (local-only), add one route:
   ```
   GET /manifest.webmanifest → readFileSync(manifest, fallback dist paths),
     res.type("application/manifest+json")
   ```
   Reuse the same dist→package-dist fallback chain as `consoleHtml()` (extract a
   tiny shared reader). It lives inside the `SERVE_CONSOLE` guard so the
   API-only hosted deploy (`SERVE_CONSOLE=false`) never exposes it.

Manifest values:
```json
{
  "id": "/",
  "name": "AgentGem Console",
  "short_name": "AgentGem",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#f1eadb",
  "theme_color": "#f1eadb",
  "icons": [ /* 192, 512 any + 512 maskable, as data: URIs */ ]
}
```

### Target B — Marketplace `app.agentgem.ai` (`packages/marketplace`, Vite SPA)

The marketplace is a Vite SPA served from Cloudflare Workers Static Assets,
fronted by `src/worker.ts`. The Worker only rewrites `GET /games/<key>`
requests (OG-tag injection) and delegates **everything else** to
`env.ASSETS.fetch` — so `/manifest.webmanifest` and icon files pass through to
Static Assets untouched. **No `worker.ts` change, no CI change.**

This is a standard Vite PWA (real HTTPS, files served as-is):

1. **`packages/marketplace/public/`** (new dir — Vite copies `public/*` verbatim
   into `dist/`):
   - `manifest.webmanifest`
   - `icon-192.png`, `icon-512.png`, `icon-512-maskable.png`

2. **`packages/marketplace/index.html`** `<head>` gains:
   - `<link rel="manifest" href="/manifest.webmanifest">`
   - `<link rel="apple-touch-icon" href="/icon-192.png">`
   - `<meta name="theme-color" media="(prefers-color-scheme: light)" content="#f1eadb">`
   - `<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#20190f">`
     (the marketplace has light+dark themes, so per-scheme title-bar color)

Manifest values:
```json
{
  "id": "/",
  "name": "AgentGem",
  "short_name": "AgentGem",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#f1eadb",
  "theme_color": "#f1eadb",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icon-512-maskable.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

## Icons (shared artwork)

One app icon rendered from the existing boot-splash gem silhouette
(`M6 3h12l4 6-10 12L2 9l4-6Z`): a terracotta gem (`#9a3324`) with hairline
facets on a warm-paper (`#f1eadb`) field. Three renditions:

- **192×192** and **512×512** — `purpose: "any"`, gem fills most of the frame.
- **512×512 maskable** — gem inset into the maskable **safe zone** (~80% inner
  circle) with paper filling the full bleed, so Android/Chrome mask crops don't
  clip it.

Generated **once** with the browser harness (draw the SVG at each size → capture
PNG). The console encodes them as base64 in `icons.ts`; the marketplace commits
them as PNG files under `public/`. The three PNGs are **duplicated** across the
two targets rather than introducing cross-package build-asset sharing — copying
three small files is cheaper than the machinery to share them.

## Testing / verification

- **Console:** `build-console.test.mjs` asserts the manifest lands in
  `dist/public/console/`. Manual: build, run the local server, open
  `http://127.0.0.1:<port>/` in Chrome → DevTools ▸ Application ▸ Manifest shows
  no errors and the icons; the omnibox "Install" icon appears; install → app
  opens in a standalone window.
- **Marketplace:** build, `wrangler dev` (or preview), confirm
  `GET /manifest.webmanifest` and `/icon-*.png` return 200 with correct
  content-types (not the SPA HTML fallback), and Chrome offers install. Verify
  the Worker still injects OG tags on `/games/<key>` (unchanged path).

## Non-goals

- Service worker / offline support.
- Push notifications, background sync, share-target, or other advanced PWA APIs.
- Any change to the Electron desktop app.
- Exposing the manifest on the API-only hosted server (`SERVE_CONSOLE=false`).
