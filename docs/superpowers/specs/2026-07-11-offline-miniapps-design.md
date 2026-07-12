# Offline-friendly marketplace miniapps

**Date:** 2026-07-11
**Status:** Design approved, ready for implementation planning
**Scope:** `packages/marketplace` (the `app.agentgem.ai` SPA)

## Problem

Miniapps published to `app.agentgem.ai` cannot be played offline. The app already
ships an installable PWA manifest (`public/manifest.webmanifest`, `display: standalone`),
so it can be *installed* — but with **no service worker**, nothing is cached, so an
installed app opened offline shows nothing and no game is replayable without a
connection.

## Key architectural facts (why this is a clean fit)

- **Each miniapp is already self-contained.** `GamePlayer.tsx` seals every game into a
  null-origin sandboxed iframe with CSP `default-src 'none'`. The game cannot make any
  network request; all assets are inlined/data-URI. Once its HTML is in the browser, the
  game runs with zero connectivity.
- **The single network dependency is fetching that HTML.** The SPA calls
  `api.getGameHtml(key, version)` →
  `GET https://api.agentgem.ai/api/aggregator/game-html?key=…&version=…` at play time.
  Caching that one JSON response = the whole game works offline.
- **Games are versioned and immutable per version.** The `version` in the URL makes each
  `game-html` request a unique, immutable URL. "Cache by URL" therefore means a new
  version is a fresh cache entry and the old one ages out naturally — no manual
  game-cache invalidation anywhere.
- **Cross-origin, but CORS-readable.** `game-html` is served from `api.agentgem.ai`
  (different origin from `app.agentgem.ai`) as a CORS `200` JSON response the SPA already
  reads. A service worker on `app.agentgem.ai` can intercept and cache it normally (not
  opaque).
- **Static hosting:** the SPA is Cloudflare Workers Static Assets, fronted by
  `src/worker.ts`, which runs worker-first only to inject OG/unfurl tags on
  `GET /games/<key>` and falls through to `env.ASSETS.fetch` for everything else. The SW
  file and manifest fall through untouched.

The only cache-invalidation problem that remains is the **shell** (Vite emits hashed
filenames; a stale shell after deploy is the classic silent PWA bug). That is exactly
what Workbox owns.

## Goals

1. **Automatic recently-played offline** — any game you have opened replays offline, with
   no user action.
2. **Explicit "Download for offline"** — a per-game pin that guarantees offline
   availability, with a managed library (list, sizes, remove, clear all).
3. **App shell offline** — the installed PWA opens offline and degrades gracefully.

## Non-goals (v1)

- **Private/owner games** (`/api/catalog/game-html`, credentialed). v1 targets the public
  marketplace browse experience only.
- **"Newer version available" prompts on a stale pin.** Pins are version-locked and keep
  working; surfacing an update is a later nicety.
- **Full offline catalog browsing** (caching the listing API so the grid populates with no
  connection). v1 relies on the precached shell + a "reconnect to browse" state.
- **Google Fonts offline.** Fraunces (headings) falls back to system serif offline
  (`display=swap` already in place). Body text is already system-font. An optional font
  runtime-cache can be added later for the exact look offline.

## Approach

`vite-plugin-pwa` in **`injectManifest`** mode. This gives Workbox's precache +
cache-busting (the reason to use the plugin at all) while letting us hand-write the small
routing logic that fully-declarative `generateSW` cannot cleanly express
("check the pinned cache before the recently-played LRU").

## Components

### 1. Service worker generation — `vite.config.ts`

Add `vite-plugin-pwa` (dev dependency) and configure:

```ts
VitePWA({
  strategies: "injectManifest",
  srcDir: "src",
  filename: "sw.ts",
  manifest: false,          // keep the hand-authored public/manifest.webmanifest + <link rel="manifest">
  registerType: "prompt",   // controlled "Update available — reload" toast; never auto-reload mid-game
  injectManifest: { globPatterns: ["**/*.{js,css,html,png,svg,woff2,webmanifest}"] },
})
```

- `manifest: false` so the plugin does not regenerate/fight the existing manifest.
- `registerType: "prompt"` (decision): a new deploy surfaces a small non-intrusive toast
  rather than auto-reloading, so a running game is never interrupted.

### 2. Service worker — `packages/marketplace/src/sw.ts`

- `precacheAndRoute(self.__WB_MANIFEST)` — Workbox-injected hashed shell (JS/CSS/HTML/icons).
  Covers offline app-open and all UI.
- One route matching the `game-html` endpoint. **Custom handler order:**
  1. **`games-pinned`** cache — checked first; served from here, never LRU-evicted.
  2. **`games-recent`** — `StaleWhileRevalidate` + `ExpirationPlugin({ maxEntries: 20 })`.
     Every opened game lands here; past the cap the oldest evicts. This is the automatic
     recently-played behavior.
- The "which cache to use" decision is extracted into a **pure function** so it is unit
  testable without a real SW environment; the SW wiring stays thin.
- Standard lifecycle for `registerType: "prompt"`: `skipWaiting` on a message from the
  update toast, then `clients.claim`.

`maxEntries: 20` is a single named constant, not a config surface.

### 3. Pin management — `packages/marketplace/src/offline.ts` (app-side)

Pure app-side module (Cache Storage is available in the window context):

- `pinGame(key, version)` — builds the **exact** `game-html` URL that `api.getGameHtml`
  builds (deterministic query order via the existing `buildQs` → exact key match with the
  SW route), fetches it, `caches.open("games-pinned").put(url, res)`, and records
  `{ key, version, title, size, pinnedAt }` in a `games-pinned-index` localStorage entry.
- `unpinGame(key, version)` — `caches.open("games-pinned").delete(url)` + remove from index.
- `listPinned()` — read the index (so the UI never has to walk Cache Storage).
- `isPinned(key, version)`.
- Storage readout via `navigator.storage.estimate()`; optional `navigator.storage.persist()`
  to protect pins from eviction.

The URL built here and the URL matched in `sw.ts` MUST be identical — this is the single
correctness invariant that ties the two files together and gets an explicit test.

### 4. UI surfaces

- **"Download for offline" control** on the **Gem detail page** (`pages/Gem.tsx`).
  States: `Download for offline` → spinner (pinning) → `Available offline ✓ · Remove`.
  Kept out of the sealed `GamePlayer` component, which stays generic.
- **Offline library** — new `/offline` route + nav entry (decision). Lists pinned games
  (title, size), per-item remove, total storage used, and "Clear all."
- **Offline state:**
  - Global banner when `navigator.onLine === false`.
  - Game cards reflect availability: pinned or recently-played = playable; otherwise greyed
    "needs connection."
  - Opening an uncached game offline reuses `GamePreview`'s existing error path
    (`setErr(true)`) with clearer copy ("Not available offline").

### 5. OG worker coexistence — `src/worker.ts`

No worker change needed: `/sw.js` and `/manifest.webmanifest` already fall through to
`env.ASSETS`. Add a guard test mirroring the existing manifest guard: the OG worker never
intercepts `/sw.js`. The SW is served at root (`/sw.js`) so it controls the `/` scope
(vite-plugin-pwa default).

## Data flow

```
Online play:
  card/detail → api.getGameHtml(key,version)
    → fetch api.agentgem.ai/api/aggregator/game-html?key=…&version=…
    → SW route: pinned? serve pinned : SWR(games-recent) [caches on the way through]
    → html → GamePlayer seals into null-origin iframe (CSP default-src 'none') → runs

Download for offline:
  Gem page "Download" → offline.pinGame(key,version)
    → fetch same URL → caches.put('games-pinned', url, res) + index entry

Offline open:
  navigator.onLine === false → banner; cards show availability
  play a pinned/recent game → SW serves from cache → runs
  play an uncached game → fetch fails → "Not available offline"

Deploy / update:
  new build → Workbox precache manifest changes → SW 'waiting'
    → "Update available — reload" toast → user reloads → new shell
```

## Testing (marketplace tests gate CI)

- `offline.ts`: pin / unpin / list / isPinned against mocked Cache Storage + localStorage
  (jsdom). Includes the URL-identity assertion (pinned URL == route-matched URL).
- SW "which cache" pure function: unit tested in isolation (pinned-first, LRU fallback).
- `worker.ts`: guard test that `/sw.js` (and, already covered, `/manifest.webmanifest`)
  pass through untouched.
- Component tests (React Testing Library, already in use): pin-button state machine,
  offline banner, offline library list.

## Edge cases & decisions

- **Storage limits** — bounded by the `games-recent` `maxEntries` LRU and user-managed
  pins; `navigator.storage.estimate()` surfaces usage; optional `storage.persist()`.
- **Version churn** — because `version` is in the URL, a new version is a fresh
  `games-recent` entry and the old one LRU-evicts; pins are version-locked and keep working.
- **Query-string ordering** — `pinGame` reuses the existing URL builder so the cache key
  matches the SW route exactly; this is asserted in tests.
- **Fonts** — offline falls back to system serif (acceptable); optional font runtime-cache
  deferred.

## Process note

Implementation happens on the `offline-miniapps` worktree branched off freshly-fetched
`origin/main`. Integration via PR gated on `test (24)`.
