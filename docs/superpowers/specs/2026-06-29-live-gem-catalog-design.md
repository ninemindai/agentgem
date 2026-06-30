# Live Gem-Catalog (browse-only, cached, static fallback) — Design

**Date:** 2026-06-29
**Status:** Approved (brainstorming) — ready for implementation plan

## Goal

Make the marketplace `/gems` browse read a **live registry index** over a public, CORS-open, server-cached endpoint — and **fall back to the curated static catalog** when the registry is empty, unconfigured, or errors. This swaps M1.5's static `listGems`/`getGem` seam to a live source without regressing the demo (prod is never bare; the curated gems' ingredient cross-links survive until real gems are published).

## Context

The gem registry is GitHub-backed (`src/gem/registryGithub.ts`, Contents API, token-optional via `AGENTGEM_REGISTRY_REPO`/`AGENTGEM_REGISTRY_REF`/`GITHUB_TOKEN`). The desktop console already searches it via the loopback `GET /api/registry/search` (`gem.controller.ts`), which loads the registry **index** (`registryConfigFromEnv()` + `githubRegistrySource(cfg)`). The index's per-gem discovery block carries `{ author?, artifactKinds?, description?, tags? }` + key/version — enough for **browse**, but **not** the per-gem ingredient ids (those live in each gem's archive). M1.5 (`packages/marketplace`) ships a static catalog of 7 curated gems behind a `listGems`/`getGem`/`filterGems` seam, with ingredient cross-links to the live M1 ingredient pages.

Two constraints shape this:
- **GitHub rate limit:** unauthenticated Contents API is 60 req/hour — a public site must not hit GitHub per-visitor. A short server-side **TTL cache** of the index fixes this (one fetch refreshes for all visitors).
- **Empty prod registry:** `AGENTGEM_REGISTRY_REPO` is unset in prod, so the live index is empty until the user stands up a repo + publishes gems. The marketplace must degrade gracefully.

## Scope decision

**Browse-only.** The live endpoint serves the index's discovery metadata; live gems carry **no ingredients** (no cross-links). Live ingredient detail (archive resolution + an artifact→aggregator-id mapping) is a deferred "full" slice. **Static fallback:** when the live list is empty or the fetch fails, the marketplace uses the curated `STATIC_GEMS` (which keep their ingredient cross-links).

## Backend — one cached public endpoint

A new route on the gem controller:

- **`GET /api/registry/gems`** → `{ gems: RegistryGem[] }`, where
  ```ts
  RegistryGem = { key: string; version: string; author?: string; description?: string; tags?: string[]; artifactKinds?: string[] }
  ```
  Each entry is mapped from the registry index's discovery block + key/latest-version. No `ingredients` (browse-only).
- **TTL cache** (in-memory, module-level, ~5 min): `{ at: number; gems: RegistryGem[] }`. On request, if fresh, return cached; else fetch the index via `registryConfigFromEnv()` + `githubRegistrySource(cfg)`, map, cache, return. One GitHub fetch per TTL window regardless of traffic — this is the rate-limit protection.
- **Graceful empty:** if `registryConfigFromEnv()` is unconfigured (no repo) **or** the index fetch throws → return `{ gems: [] }`. The public path must never 500; the frontend's fallback handles the empty list.
- **CORS:** add `/api/registry/gems` to `originGuard`'s `PUBLIC_READ_PATHS` set (safe-method, credential-less → `Access-Control-Allow-Origin: *`).
- **Rate limiting:** none added. The aggregator's anon limiter is mounted only at `/api/aggregator`, and the TTL cache already bounds GitHub traffic; the endpoint is a cheap in-memory read. A per-IP limit on it is a deferred nicety, not required for the rate-limit goal.
- The existing loopback `GET /api/registry/search` (desktop console) is **untouched** — it stays uncached and origin-guarded.

## Frontend — async seam + fallback (`packages/marketplace`)

- **api client:** extend `makeApi(base)` with `getGems(): Promise<RegistryGem[]>` (GET `/api/registry/gems`, returns `body.gems`). `RegistryGem` is redeclared in the marketplace's `types.ts` (mirrors the server shape).
- **`gems/catalog.ts`:**
  - Keep the 7 curated gems, renamed to `STATIC_GEMS` (each still has `ingredients`).
  - `async loadGems(api): Promise<Gem[]>` — `await api.getGems()`; map each `RegistryGem` → `Gem` with `ingredients: []`; **if the result is empty OR the fetch throws → return `STATIC_GEMS`**.
  - Keep `filterGems(gems, query)`; add pure `findGem(gems: Gem[], key: string): Gem | undefined`.
  - (The old sync `listGems`/`getGem` are removed; the pages move to `loadGems`/`findGem`.)
- **`pages/Gems.tsx`** → async: `useEffect` loads gems (with an `alive` guard), a **loading** state, then renders `filterGems(gems, search)`. Search/empty/no-match states as in M1.5. Takes the `api` prop now (Router passes it).
- **`pages/Gem.tsx`** → async: load gems, `findGem(key)`; render fields; render the **Contains** section only when `ingredients.length > 0` (live gems → hidden; fallback gems → cross-links shown). Loading / not-found / error states. Takes `api` + `keyName`.
- **`Router.tsx`:** `/gems` and `/gems/:key` now pass `api` to `Gems`/`Gem` (they were prop-less; now they fetch).

## Data flow

browser → `app.agentgem.ai/api/registry/gems` (CORS-open, TTL-cached) → live gems, or `{ gems: [] }` on unconfigured/error → `loadGems` falls back to `STATIC_GEMS`. No per-gem endpoint: the cached list is small, so `Gem` loads the list and `findGem`s client-side.

## Out of scope (later)

- Live **ingredient** cross-links for registry gems (archive resolution + artifact→aggregator-id mapping).
- Publishing/auth; per-IP rate-limiting the public endpoint.
- **Populating the registry repo** + setting `AGENTGEM_REGISTRY_REPO`/`GITHUB_TOKEN` on the hosted server — the user's infra step; the endpoint returns `[]` (→ static fallback) until then.

## Testing

- **Backend** (server vitest, compiled-dist convention): the endpoint maps an injected fake registry source's index → `{ gems }`; returns `{ gems: [] }` when unconfigured; returns `{ gems: [] }` (not 500) when the source throws; serves cached on a second call within TTL (the source is fetched once); `originGuard` sets `Access-Control-Allow-Origin: *` for `GET /api/registry/gems`. Inject the registry source so no real GitHub call happens.
- **Frontend** (marketplace vitest+jsdom): `loadGems` returns mapped live gems on success; falls back to `STATIC_GEMS` on empty result and on a thrown fetch (stub `getGems`); `Gems` shows a loading state then renders gems; `Gem` renders a live (ingredient-less) gem with **no** Contains section, and a fallback gem **with** its Contains cross-links; `findGem` hit/miss.
- Full gates: `pnpm --filter @agentgem/marketplace test|typecheck|build`, and the server package's `pnpm test` (tsc -b + vitest) for the controller/originGuard.

## Risks

- **Index shape drift:** the mapping from the registry index discovery block to `RegistryGem` must tolerate missing optional fields (author/description/tags/artifactKinds) — map defensively.
- **Async test flakiness:** the page tests must `await` the loaded state (`findBy*`/`waitFor`) to avoid racing the `useEffect` — no bare `getBy*` before load.
- **Fallback masking errors:** since empty/error both fall back to `STATIC_GEMS`, a misconfigured-but-reachable registry looks identical to "no registry." Acceptable for browse-only; the server logs the fetch error.
