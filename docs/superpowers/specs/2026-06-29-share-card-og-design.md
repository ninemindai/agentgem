# Share Card — hosted OpenGraph certificate (Milestone C) — design

_Spec 2026-06-29. Implements "Milestone C — share the built Gem via an OG card" from
`2026-06-28-mine-panel-v2-design.md`. This iteration ships the **certificate** subject (the
goldmine scorecard itself); the **Gem** subject is a fast-follow on the same infrastructure._

## Goal

Turn the local-only goldmine trophy into a **hosted share card** whose preview renders natively
in X / Facebook / LinkedIn feeds. Today the Mine panel draws a trophy PNG on a `<canvas>` and lets
you download / `navigator.share` the file. Social platforms cannot render a preview from a local
file or from `localhost` — they fetch OpenGraph/Twitter-Card meta from a **public URL**. So this
milestone introduces the project's first interactive public surface: `https://agentgem.ai/share/:id`.

Success criterion: a user clicks "Share" on their goldmine trophy, gets a public
`agentgem.ai/share/:id` URL, posts it to X/LinkedIn/Facebook, and the platform auto-renders a rich
card image ("N reusable workflows · M battle-tested · K worth sharing — valued with AgentGem") with
an invite CTA back to AgentGem.

## Decisions (locked during brainstorming, 2026-06-29)

1. **Hosting** — extend the EXISTING Cloudflare Worker `agentgem-web` (`website/edge/`,
   `run_worker_first = true`, serving `agentgem.ai`). Reuses the deployed domain, the
   `deploy-worker.yml` CI pipeline, and `CLOUDFLARE_API_TOKEN`. No new platform, project, or secret.
2. **Card subject** — **certificate first** (aggregate goldmine counts). Independent of Gem-building,
   so we can deploy and verify real previews fastest. The Gem card is a fast-follow.
3. **Backend** — assume a hosted backend exists; build the share feature against its API contract.
   The backend is the existing **aggregator service** (agentback `RestApplication` +
   Drizzle/Postgres) extended with a `ShareController`. Cloud-deploying it (queued issue #38) is a
   **separate track**; this spec works locally on pglite and defines the contract, and the
   real-preview verification waits on that deploy.
4. **OG image** — author the card as an **SVG template**, rasterized to PNG **at the edge** via
   `resvg-wasm`. (`og:image` cannot be an SVG — crawlers only rasterize PNG/JPG/WebP/GIF — so SVG is
   the *source*, PNG is delivered.) Backend stores **JSON only** (no image bytes). The same
   `renderCardSvg(counts)` renders the in-app card, so the in-app and shared images share one source.

## Non-goals (v1)

- **No Gem card.** Same `/share` infra + a registry resolver + install link — fast-follow.
- **No verified counts.** The scorecard is computed from LOCAL session logs that never leave the
  machine (local-first privacy), so the backend can only store **self-reported** aggregates. Server
  storage buys stable/short/revocable ids and a clean public read — not a verified credential. This
  matches the scorecard spec deferring any comparative/leaderboard score "until proof-of-paid-use."
- **No leaderboard / comparison / percentile.**
- **No delete/revoke UI.** Records are create-only in v1 (follow-up below).
- **No account gate.** Create is anonymous + rate-limited (frictionless viral loop).
- **No new transcript parsing or scorecard logic.** Reuse the shipped `Scorecard` verbatim.

## Architecture & data flow

```
┌─ Console (local app @ 127.0.0.1) ─────────────────────────────────────┐
│  renderCardSvg(counts) -> inline SVG (in-app card)   [NEW, replaces canvas trophy] │
│  POST /api/share {kind, counts, generatedAtMs}  -> LOCAL app (same origin)         │
│  show url + Copy + X/LinkedIn/Facebook intents + navigator.share(url)              │
│  "Download PNG" offline fallback: rasterize the SVG in-browser (Image->canvas->toBlob) │
└───────────────┬───────────────────────────────────────────────────────┘
                │ same-origin (no CORS, satisfies originGuard)
┌───────────────▼─ Local app REST server (src/) ───────────────────────┐
│  POST /api/share -> shareClient.postShare(...)                         │
│     forwards to AGENTGEM_AGGREGATOR_URL  [reuse producer pattern]      │
│     (unset in pure-local dev -> use the in-process aggregator)         │
└───────────────┬───────────────────────────────────────────────────────┘
                │ server-to-server (mirrors src/gem/ingestClient.postAttestation)
┌───────────────▼─ Hosted aggregator backend (deployed via #38; local: pglite) ──┐
│  share_cards: id, kind, counts{breadth,battleTested,portable}, generatedAtMs, createdAtMs │
│  POST /api/share      -> validate + rate-limit + store -> {id, url}    │
│  GET  /api/share/:id  -> {kind, counts, generatedAtMs, createdAtMs}  [public] │
└───────────────▲───────────────────────────────────────────────────────┘
                │ server-to-server fetch (edge-cached)
┌───────────────┴─ Edge Worker (agentgem.ai, website/edge) ────────────┐
│  GET /share/:id        -> OG/Twitter HTML + card <img> + invite CTA + share buttons │
│  GET /share/:id/og.png -> renderCardSvg(counts) -> resvg-wasm -> PNG  [immutable edge cache] │
│  AGGREGATOR_API var; graceful "sharing coming soon" placeholder until backend deployed │
└───────────────────────────────────────────────────────────────────────┘
```

**Why the local app proxies the create call** (console → local → hosted, rather than the browser
calling the hosted backend directly): keeps the browser **same-origin** (no CORS, satisfies the
existing `originGuard`), and reuses the established server-side producer config
(`AGENTGEM_AGGREGATOR_URL`) and client shape (`src/gem/ingestClient.ts:postAttestation`).

**Why all public URLs stay on `agentgem.ai`**: `og:image` points at `agentgem.ai/share/:id/og.png`
(the Worker), not a backend URL — one canonical host in the social card, and the image is rasterized
+ hard-cached at the edge.

## The card content (single source of truth)

`renderCardSvg(counts)` is the canonical 1200×630 SVG. Content mirrors the existing
`packages/console/src/panels/Mine/trophy.ts:trophyLines` exactly — **counts only**:

- title: "My Agent Goldmine"
- `${breadth} reusable workflows`
- `${battleTested} battle-tested`
- `${portable} worth sharing`
- tagline: "Valued with AgentGem" + the AgentGem wordmark

Visual style carries over the trophy's dark theme (`#0b0f17` bg, `#7cc4ff` accent, `#e8edf5` ink).
No project names, no workflow names, no gaps, no per-project data — see Privacy pass.

### Two-runtime parity

`renderCardSvg` must run in two bundles that do **not** share a build: the console (TS,
`packages/console`) and the edge Worker (plain JS, `website/edge`). Because it is a pure string
function with no dependencies, the pragmatic approach is a single canonical implementation plus a
**parity snapshot test** asserting both runtimes emit byte-identical SVG for the same counts.

- Canonical source: `website/edge/src/card.js` (plain JS, no imports) — the Worker imports it
  directly; the console imports the same file (esbuild can bundle a relative `.js`), OR a thin TS
  re-export wraps it. The plan picks the exact wiring; the invariant is **one implementation, one
  snapshot test exercised from both sides**.

## Backend contract (new `ShareController` in the aggregator service)

`share_cards` table (Drizzle/pg — the existing aggregator stack; pglite in tests):

| column          | type      | notes                                              |
| --------------- | --------- | -------------------------------------------------- |
| `id`            | text PK   | server-generated short base62 (~10 chars)          |
| `kind`          | text      | `'certificate'` (v1)                               |
| `counts`        | jsonb     | `{ breadth, battleTested, portable }` — non-negative ints |
| `generatedAtMs` | bigint    | from the scorecard                                 |
| `createdAtMs`   | bigint    | server clock                                       |

Routes:

- **`POST /api/share`** — body `{ kind: "certificate", counts: { breadth, battleTested, portable }, generatedAtMs }`.
  Zod-validated: `kind` is the allowed literal; counts are non-negative integers; **unknown fields
  are stripped** (privacy — `.strict()`/explicit shape, never `.loose()`). Rate-limited by IP (reuse
  the aggregator's rate-limit infra). **Anonymous** — no account/email stored. Returns `{ id, url }`,
  where `url = ${SHARE_BASE}/share/${id}` and `SHARE_BASE` defaults to `https://agentgem.ai`.
- **`GET /api/share/:id`** — public read; `{ kind, counts, generatedAtMs, createdAtMs }`. 404 when
  unknown. Aggregate only.

The local app exposes a thin same-origin `POST /api/share` that forwards to the hosted backend via a
new `src/gem/shareClient.ts` (mirrors `ingestClient.ts`), using `AGENTGEM_AGGREGATOR_URL`. When that
env is unset (pure local dev), it targets the in-process aggregator so the flow works end-to-end
locally on pglite.

## Edge Worker `/share` route (extend `website/edge/src/markdown-negotiation.js`)

The Worker already runs first on every request (`run_worker_first = true`), so the `/share` branch
sits before the existing markdown-negotiation / `env.ASSETS` logic and after the `CANONICAL_HOST`
redirect.

- **`GET /share/:id`** → fetch backend `GET ${AGGREGATOR_API}/api/share/:id`.
  - On hit: return HTML from a pure `renderShareHtml(record)` with
    - OG/Twitter meta: `og:title`="My Agent Goldmine", `og:description`="N reusable workflows · M
      battle-tested · K worth sharing — valued with AgentGem",
      `og:image`=`https://agentgem.ai/share/:id/og.png`, `og:url`, `og:type`=website,
      `twitter:card`=`summary_large_image`.
    - Visible body: the card image (`<img src=".../og.png">`) + invite CTA ("Value your own agent
      goldmine →" → `agentgem.ai`) + share buttons.
  - 404 → a friendly "card not found" page.
  - Edge-cache the HTML via the Cache API.
- **`GET /share/:id/og.png`** → fetch counts → `renderCardSvg(counts)` → `resvg-wasm` → PNG.
  `Cache-Control: public, max-age=31536000, immutable`; also store in the edge Cache API.
- **Config**: new `AGGREGATOR_API` wrangler var (backend base URL). When unset/empty, `/share/*`
  returns a graceful "sharing coming soon" placeholder (HTML + a static placeholder image), so the
  Worker never breaks before #38 lands.
- **Fonts**: `resvg` needs font bytes to render text. Bundle ONE subset font (the glyphs the card
  uses — digits, the static label words, and the wordmark) as a Worker asset/import to keep size
  small.

## Console share upgrade (`packages/console/src/panels/Mine`)

Replace the canvas trophy share path:

1. In-app card: render `renderCardSvg(counts)` inline (crisp, scales) — retire `drawTrophy` for the
   trophy. `trophyLines` content moves into the SVG template (or the template imports it).
2. Share: `createShareCard(counts, generatedAtMs)` → `POST /api/share` (local, same origin) →
   `{ id, url }`.
3. UI: show `url` with **Copy**, **X / LinkedIn / Facebook** intent buttons (open the hosted `url`),
   and a **`navigator.share({ url })`** fallback.
4. **Download PNG** offline fallback retained: rasterize the inline SVG in-browser
   (`Image` → `<canvas>` → `toBlob`) — no bespoke drawing code.

New pure module `packages/console/src/panels/Mine/shareIntents.ts` — X `intent/tweet?url=&text=`,
LinkedIn share, Facebook `sharer.php?u=` URL builders. Pure + unit-tested.

## Privacy pass

- The share record and the SVG carry **only** `breadth`, `battleTested`, `portable`,
  `generatedAtMs`. **Never** `gaps`, `projects`, roots, labels, candidate names, or raw logs — the
  exact boundary the scorecard spec already mandates ("counts only, so project/workflow names can
  never leak"; per-project data is "IN-APP ONLY (never on trophy)").
- Enforced in two places: a typed counts payload, and zod on `POST /api/share` that rejects/strips
  unknown fields (never `.loose()`).
- Because the image is now **server-authored from the stored counts** (SVG template, not a
  client-uploaded bitmap), the image and the counts cannot disagree, and there is no arbitrary-image
  upload surface.
- Public reads are aggregate-only, no PII, no auth to view. Create is anonymous (no account/email).
- **Stated limitation**: counts are **self-reported** by the local client (local-first means the
  backend never sees raw logs to verify them). The card is a vanity certificate, not a verified
  credential. Signing/verification is a future enhancement gated on a real trust system.

## Testing & verification

- **Backend (`ShareController`, pglite)**: store/read roundtrip; zod rejects negative counts,
  wrong `kind`, and extra fields; `GET` 404 on unknown id; rate-limit path.
- **`shareClient.ts`**: forwards to `AGENTGEM_AGGREGATOR_URL`; falls back to in-process when unset
  (mirror the `ingestClient` tests).
- **Console**: `shareIntents` URL builders (pure); `createShareCard` with mocked fetch; the upgraded
  share interaction; the in-browser SVG→PNG fallback (smoke).
- **Card SVG**: `renderCardSvg(counts)` snapshot, exercised from BOTH the console and Worker test
  suites (parity).
- **Worker**: pure `renderShareHtml(record)` (correct, escaped OG/Twitter meta); `/share` and
  `/share/:id/og.png` routing including the `AGGREGATOR_API`-unset placeholder; resvg-wasm produces a
  valid PNG of expected dimensions.
- **End-to-end OG preview** (the "needs a deploy" step): after the #38 backend deploy + a Worker
  deploy, validate a real `agentgem.ai/share/:id` with X Card Validator, Facebook Sharing Debugger,
  and LinkedIn Post Inspector.

## Roadmap / follow-ups

- **Gem card** (fast-follow): same `/share` infra; `:id` resolves a registry coordinate
  (`@scope/name@version`); card adds provenance + an install link + invite. Wires the per-workflow /
  build-result Share buttons (build a 1-skill Gem → publish → share).
- **#38 cloud deploy** of the aggregator backend (separate track) — unblocks real-preview
  verification and turns the local-proxy fallback into the real hosted path.
- **Delete/revoke** a share card (owner token at create, or account-bound) — deferred.
- **Verified counts / signed credential** — gated on a trust system (proof-of-paid-use).
