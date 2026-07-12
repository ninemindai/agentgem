# Branded OG cards for all shareable AgentGem links (V1)

**Date:** 2026-07-12
**Status:** Design approved, ready for implementation plan
**Scope:** Phase 1 of 2. Generalized, branded Open Graph cards for four link types,
implemented as a **deployment-agnostic** core. Miniapp publish-time screenshot capture
is deferred to a separate phase-2 spec (see "Out of scope").

## Problem

Sharing an AgentGem link into Slack/X/iMessage/LinkedIn produces a poor unfurl:

- `app.agentgem.ai/games/<key>` (miniapps) already gets a **text-only** card — a
  facade injects `og:title` + `og:description` + `twitter:card=summary`, but **no image**.
- `app.agentgem.ai/gem/<key>`, `/@handle`, and `/leaderboard` get **no card at all** —
  they are client-rendered SPA routes, so a crawler sees an empty React shell.

Only the explicitly-minted `agentgem.ai/share/:id` certificate card carries a real
image today (SVG rasterized to PNG via `@resvg/resvg-wasm`).

We want every shareable link to unfurl with a branded `summary_large_image` card, using
one shared mechanism — **and without depending on Cloudflare Workers as the facade
layer.** The logic must run on any host that can run Node.

## Goals

- Every one of the four link types below unfurls with a branded 1200×630 image card and
  correct title/description meta.
- One generalized `route → { type, key }` resolver and **one** image renderer — no
  per-type copy-paste, no second rasterizer codebase.
- **Deployment-agnostic:** the OG logic is a runtime-neutral module deployed by default
  as a portable Node (`@agentback`) HTTP handler in the aggregator. No Cloudflare
  primitive (`run_worker_first`, `env.ASSETS`, Workers-only APIs) is required to serve a
  correct card. An edge/CDN layer is *optional acceleration*, not a dependency.
- The image renderer takes an entity **identity** (`type` + `key`) and fetches real
  catalog metadata itself; it is **not** an open "render arbitrary text" endpoint.
- Degrade safely: any handler/meta/render error falls through to the unmodified SPA (a
  card bug must never take the site down).

## Non-goals (V1)

- Per-miniapp screenshots / live previews of app content (phase 2).
- Any change to the `/share/:id` certificate or gem cards — that spine is untouched.
- New console UI. V1 is entirely origin-handler + aggregator; no publish-flow change.
- A formal multi-platform adapter package/interface. We ship the portable core + the
  Node handler + one optional thin CF adapter; additional adapters are added ad hoc if a
  new host appears.
- Cards for routes not listed (e.g. org catalog, settings) — additive later via the
  same resolver.

## Link types in scope

| Route (on `app.agentgem.ai`) | `type` | Card title | Card subtitle | Meta source |
|---|---|---|---|---|
| `/games/:key` | `game` | miniapp name | genre · ▶ N plays | `game-meta` (extended) |
| `/gem/:key` | `gem` | gem name | provenance ("Distilled from N sessions" / "N skills") · type badge | catalog record |
| `/@handle` | `profile` | `@handle` | "N apps · N reviews on AgentGem" | profile hub counts |
| `/leaderboard` (+ scoped variants) | `leaderboard` | board name | "Top miniapps this week" / top entry | leaderboard query |

Route→type matching lives in one table in the core, mirroring `entityPath.ts`'s existing
parse helpers where they exist (`parseGamePath`). The `gem` and `profile` matchers are
new and must stay consistent with the SPA's own `Router.tsx` route table (documented as
a drift risk; covered by a test asserting the core resolves the same shapes the Router
renders).

## Architecture

### The portable core (runtime-neutral, no platform APIs)

A single module of pure functions plus small injected dependencies (an HTTP `fetch` and a
config object). It imports nothing Cloudflare-specific and nothing Node-specific — it
runs in Node, Deno, or a Worker unchanged.

```
og/
  resolveCard(pathname) → { type, key } | null           // ONE route table
  fetchMeta(fetch, cfg, type, key) → { title, description, imageUrl? }
  injectHead(shell, meta, url) → html                     // string ops, no HTML parser
  renderCardSvg({ type, title, subtitle }) → string       // branded SVG template
  renderCardPng(svg) → Uint8Array                         // @resvg/resvg-wasm (portable)
```

`cfg` carries the neutral knobs: `aggregatorOrigin` (where `og-meta` lives),
`assetOrigin` (where the built SPA `index.html` lives), and `ogImageOrigin` (the public
host that serves `/og/card.png`). All are plain URLs — no platform binding.

### Default deployment: the aggregator (`@agentback`, Node, host-agnostic)

The aggregator is already a portable HTTP service that deploys to Render/Fly/anywhere.
It hosts an `OgController` exposing two capabilities built entirely on the core:

1. **`GET /og/card.png?type=&key=`** → `fetchMeta` → `renderCardSvg` → `renderCardPng`
   → PNG bytes with cache headers. No facade, no interception — an ordinary route.
2. **Entity HTML routes** (`/games/:key`, `/gem/:key`, `/@handle`, `/leaderboard`) →
   the handler obtains the SPA shell via `fetch(cfg.assetOrigin + "/index.html")`
   (the portable equivalent of the Worker's `env.ASSETS.fetch`), runs `injectHead`, and
   returns the enriched HTML. Static assets (JS/CSS/images) are unaffected and continue
   to be served by the CDN/asset host.

A deployment with **no edge layer at all** (just the aggregator + a static asset host +
DNS) serves correct cards. The only platform-neutral requirement is a routing rule:
*"send the entity paths and `/og/*` to the OG handler; everything else to static
assets."* Every host expresses this its own way (nginx `location`, Vercel rewrite,
Render route, a CF Worker route, or a single Node server that does both).

### Optional acceleration: the Cloudflare Worker (thin, dependency-free)

On the current production topology (CF in front of `app.agentgem.ai`), an **optional**
Worker intercepts the entity paths and `/og/*` and **proxies to the aggregator's OG
handler with edge caching** (Cache API). It does not import the core and takes **zero
`@agentgem` runtime deps** — it is a `fetch`-and-cache shim — which respects the
marketplace package's established zero-dependency build constraint. Remove the Worker and
the origin still serves correct (uncached) cards.

This replaces today's `packages/marketplace/src/worker.ts` (which injects text tags
itself): the injection logic moves into the portable core/aggregator, and the Worker's
job shrinks to caching. If we later prefer edge injection for latency, the Worker can
call the aggregator's `og-meta` and reuse a bundled copy of `injectHead` — but that is
not required for V1 and is not the default.

### `og:image` is identity-driven, not text-driven

`/og/card.png` takes `type` + `key`, **not** a free-form `?title=`. It resolves real
catalog metadata via `og-meta`. The endpoint can only render entities that exist in the
catalog — it is not a general-purpose text-to-image renderer that could be abused to
render arbitrary strings. A missing entity → a **generic branded AgentGem placeholder
PNG** (never a 404 image, so a crawler always has an image).

```
crawler → <og-handler>/games/:key         (aggregator route, or CF/CDN cache in front)
            ├─ resolveCard → { game, key }
            ├─ fetchMeta(og-meta?type=game&key=…) → { title, description }
            ├─ fetch(assetOrigin + /index.html) → shell
            └─ injectHead(shell, meta, url)
                   og:image = imageUrl ?? <ogImageOrigin>/og/card.png?type=game&key=…
                   twitter:card = summary_large_image

crawler → <og-handler>/og/card.png?type=game&key=…
            ├─ fetchMeta → { title, description }
            ├─ renderCardSvg({ game, title, subtitle })
            └─ renderCardPng(svg) → 1200×630 PNG   (@resvg/resvg-wasm, cache-headed)
```

## The four card templates

All `summary_large_image` (1200×630), one shared frame (AgentGem wordmark + a per-type
accent color/label), differing only in content pulled from `og-meta`:

| Type | Title | Subtitle line | Source |
|---|---|---|---|
| **game** | miniapp name | "Play on AgentGem" + genre + ▶ N plays | `game-meta` (extend) |
| **gem** | gem name | provenance ("Distilled from N sessions" / "N skills") + type badge | catalog record |
| **profile** | `@handle` | "N apps · N reviews on AgentGem" | profile hub counts |
| **leaderboard** | board name | top entry or "Top miniapps this week" | leaderboard query |

Text is escaped and length-capped before it reaches SVG (XSS-in-SVG + layout blowout):
titles cap ~80 chars, subtitles ~120, single line with ellipsis.

Phase-2 hook: when a game later has a captured `imageUrl`, `injectHead` prefers it over
`/og/card.png` — no template or resolver change needed.

## Components

### 1. `og` core module (new, runtime-neutral)

Pure functions above. Uses `@resvg/resvg-wasm` (portable across Node/Worker/Deno) so the
rasterizer is not tied to a runtime. The certificate card already proves resvg-wasm works
in production; V1 keeps the core self-contained rather than forcing a shared refactor of
the certificate pipeline (a later cleanup could unify them). Lives where the aggregator
can import it (a small internal module/package); the optional CF Worker does **not**
import it.

### 2. `og-meta` aggregator endpoint (new)

`GET /api/aggregator/og-meta?type=<game|gem|profile|leaderboard>&key=<id>`
→ `{ title: string, description: string, imageUrl: string | null }`

- One endpoint, switch on `type`, each branch reads the same catalog/profile/leaderboard
  data the SPA reads. `imageUrl` is always `null` in V1 (the phase-2 hook).
- Public read path — must be added to `PUBLIC_READ_PATHS` (exact-match) so cross-origin
  GETs aren't blocked by `originGuard` (this has bitten every prior public GET). Keep it
  public and unauthenticated like `game-meta`.
- `game` reuses/extends the existing `game-meta` logic (add genre + play count to the
  description); the endpoint may internally delegate to it or absorb it — one or the
  other, not a half-migration (`game-meta` must keep working until any caller is moved).
- Genuinely-missing entity → **404** (mirrors the certificate `share_not_found`
  pattern). The HTML handler falls through to the plain SPA on a non-OK meta response;
  the image handler serves the placeholder PNG.

### 3. `OgController` aggregator handler (new, the default deployment)

- `GET /og/card.png?type=&key=` → PNG (core `renderCardSvg`+`renderCardPng`),
  `Cache-Control` for CDN/crawler caching; placeholder PNG on missing entity / render
  error (never a 500 image).
- `GET` entity HTML routes → `injectHead(fetch(assetOrigin+"/index.html"), meta, url)`;
  fall through to the plain shell on any non-OK meta / error.
- Reads `aggregatorOrigin` / `assetOrigin` / `ogImageOrigin` from config/env with sane
  defaults for the current hosting; all overridable so a different host works with zero
  code change.

### 4. Optional CF Worker adapter (modified — replaces `worker.ts`)

- Thin `fetch`-and-cache shim over the aggregator's OG handler for entity paths + `/og/*`.
- Zero `@agentgem` deps. Preserves the existing invariants: only `GET`, fall through to
  `env.ASSETS.fetch(request)` on any non-match / non-OK / thrown error; drop
  `content-length` when the proxied body differs.
- Removable without breaking cards (origin still serves them, uncached).

## Data flow (miniapp example)

1. Someone pastes `https://app.agentgem.ai/games/pizza-panic` into Slack.
2. Slack's crawler GETs it. The request reaches the OG handler (directly, or via the
   optional CF cache). It resolves `game`/`pizza-panic`, fetches
   `og-meta?type=game&key=pizza-panic` → `{title:"Pizza Panic", description:"Arcade · ▶ 214 plays", imageUrl:null}`,
   fetches the SPA shell, injects tags incl.
   `og:image=<ogImageOrigin>/og/card.png?type=game&key=pizza-panic` +
   `twitter:card=summary_large_image`, returns the enriched shell.
3. Slack's crawler GETs `card.png`. The handler fetches the same `og-meta`, renders the
   branded SVG, rasterizes to a 1200×630 PNG, returns it (cache-headed).
4. Slack shows the large-image card. React still hydrates and plays normally for humans.

## Error handling

- **Meta endpoint down / entity missing** → HTML handler serves the plain SPA (no card,
  as today); image handler serves the generic branded placeholder PNG.
- **Rasterizer throws** → placeholder PNG (never a 500 image).
- **Any handler exception** → unmodified shell / pass-through. No path degrades the site
  for human visitors.
- **Non-`GET` / unmatched route** → untouched.

## Testing

- **Core (runtime-neutral unit tests):** `resolveCard` over all four route shapes +
  non-matches; `injectHead` emits `summary_large_image` + `og:image` and byte-correct
  head injection; `renderCardSvg` valid SVG per `type`; text escaping/capping;
  placeholder path. These tests need no platform and run in the normal suite.
- **Aggregator:** `og-meta` returns correct shape per `type`; 404 on missing; is in
  `PUBLIC_READ_PATHS`. `OgController` serves PNG + enriched HTML and degrades on
  meta failure (inject a fake `fetch`).
- **Optional CF adapter:** caches and proxies; falls through on error. Extend
  `worker.test.ts`.
- **Drift guard:** a test asserting the core's route table resolves exactly the entity
  shapes the SPA `Router.tsx` renders (so a new SPA route that should have a card is
  caught).
- **Deploy-gated (manual):** validate live unfurls with the X, Facebook, and LinkedIn
  card debuggers once deployed — same caveat as the certificate card. Note edge cache +
  cold-start latency.

## Out of scope → phase 2 (separate spec)

- Miniapp publish-time screenshot capture (console/Studio captures the live preview
  canvas → uploads → stores a cover-image URL on the catalog record).
- `injectHead` already prefers `meta.imageUrl` when present, so phase 2 is purely: add
  the column, capture+upload in publish, populate `imageUrl` in `og-meta`. No change to
  the core resolver or the rasterizer.

## Open risks

- **Route-table drift** between the core and the SPA Router — mitigated by the drift
  guard test; keep the matchers minimal.
- **Entity HTML now touches an origin handler** rather than pure static-CDN serving —
  slightly more origin work; mitigated by cache headers + the optional edge cache.
  Acceptable for full portability.
- **SPA-shell sourcing** — the handler fetches `assetOrigin + "/index.html"` at request
  time (cached). If the asset host is unreachable, the handler must fail *open* (serve a
  minimal shell or fall through) rather than error the page. Specify the fallback.
- **Cross-host cache staleness** — a changed title/play-count leaves an edge-cached
  `card.png` stale until TTL. Acceptable for V1 (cards are promotional); document the TTL.
- **Deploy sequencing** — ship the aggregator `OgController` (`/og/card.png` + HTML
  routes) *before* anything starts emitting `og:image`, so a card never points at a
  route that isn't live yet.
