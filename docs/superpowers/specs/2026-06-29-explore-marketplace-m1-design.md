# Explore — public discovery marketplace (M1) — Design

**Date:** 2026-06-29
**Status:** Approved (brainstorm). First slice of the **two-app split**: a local **desktop app**
(`packages/console`) and a hosted **marketplace app** (this). M1 = public, read-only ingredient
discovery over the already-deployed aggregator.

## Goal

A standalone public web app at **`app.agentgem.ai`** that makes the aggregator's
trusted-adoption data legible to anyone — a leaderboard of ingredients (skills/MCPs) with
per-ingredient drill-in (co-occurrence + adoption) — driving discovery/acquisition. No
accounts. Reuses the live backend with (ideally) zero server changes.

## Context

- The **desktop app** (`packages/console`) is the local-first agent workflow (curate /
  materialize / deploy / run). It currently also hosts **Insights** + the browse half of
  **Get Gems** — which are really *marketplace* surfaces. The split gives them a public home.
- The **aggregator** is deployed at `https://agentgem.onrender.com` with **CORS-open,
  k-anon-floored** public reads: `popularity`, `co-occurrence`, `adoption`,
  `co-occurrence-matrix` (`PUBLIC_READ_PATHS` in `src/originGuard.ts`). M1 consumes these.
- A separate hosted **share-card** surface (`agentgem.ai/share/:id`) already exists for OG/
  shareable artifacts — Explore is the *interactive* discovery app, complementary to it.

## Decisions (locked in brainstorming)

1. **First slice = M1 public ingredient discovery** (leaderboard + ingredient detail). Gem
   browse/detail is a fast-follow (M1.5) once a public gem API exists; accounts + starring/
   reviews (M2) and commerce (M3) are later.
2. **Stack = Vite + React SPA**, deployed static to **Cloudflare Pages**, at the
   **`app.agentgem.ai`** subdomain. (Accepted tradeoff: client-rendered → weak SEO/OG;
   the share-card surface covers shareable artifacts separately.)
3. **Standalone over the public HTTP API.** A new monorepo package consumes *only* the
   deployed aggregator's public endpoints over fetch/CORS — **no server-code import** — which
   sidesteps the local-main ↔ origin-main divergence. It copies the few console bits it needs.
4. **Desktop goes local-only** — Insights + the browse half of Get Gems move out to Explore.
   That trim is a **separate, later PR** (it depends on choosing the canonical console across
   the divergence) and is NOT part of M1.

## Architecture

```
app.agentgem.ai (Cloudflare Pages, static SPA)
        │  fetch (CORS)
        ▼
https://agentgem.onrender.com/api/aggregator/{popularity,co-occurrence,adoption,co-occurrence-matrix}
        (public, CORS-open, k-anon ≥ K enforced server-side)
```

A new package **`packages/marketplace`** (Vite + React 19 + TypeScript, ESM), mirroring the
console's toolchain (`vitest`, `tsc --noEmit`, an esbuild/vite build). It is a pure frontend:
all data comes from the public aggregator API; nothing server-side is imported.

### Reused-by-copy (not import — to avoid the divergence)

Copied from `packages/console/src/panels/Insights/` into the new package and adapted:
- **`data.ts`** pure helpers: `prettifyId`, `kindLabel`, `verifiedShare`, `barWidths`,
  `filterRows`, `sparkPoints` (all framework-free, already unit-tested).
- The **Leaderboard / Sparkline** visual treatment (CSS + markup), re-skinned for a public
  page rather than a console panel.
- The aggregate **types** (`AggIngredient`, `AggCoOccurrence`, `AdoptionPoint`) — redeclared
  locally (they're small Zod-inferred shapes).

> Copying is deliberate: importing across packages would couple Explore to a specific console
> lineage during the divergence. The copied surface is small, pure, and already tested.

## Components / pages (M1)

### 1. API client (`src/api.ts`)
- `makeApi(base: string)` → typed `getPopularity({kind?,limit?})`, `getCoOccurrence({id,limit?})`,
  `getAdoption({id,bucket?})`. Plain `fetch` + JSON (the responses are the schema directly).
- `base` from a build-time env var `VITE_API_BASE` (default the onrender.com URL).
- Errors surface as rejected promises the pages turn into friendly states.

### 2. Home / Leaderboard (`/`)
- Ranked list from `getPopularity` — rank, prettified name + scope, kind badge, producer bar,
  `producers · N verified ✓`, verified-share bar. Kind tabs (All / Skill / MCP). Client-side
  search box (`filterRows`, ranks tied to full list). Empty state: "No ingredients above the
  k-anonymity floor yet." Each row links to the ingredient page.

### 3. Ingredient detail (`/ingredient/:id`)
- Header = prettified id. **Used together with** = `getCoOccurrence` list. **Adoption** =
  `getAdoption` sparkline (producers + verified series) with week/month toggle. The id is URL-
  encoded in the path; a clean, shareable public URL.

### 4. Routing + shell (`src/main.tsx`, `src/Router.tsx`)
- A tiny hash- or history-based router for `/` and `/ingredient/:id`. **History routing
  requires a Cloudflare Pages SPA fallback** (`_redirects`: `/* /index.html 200`) so deep
  links resolve. Brand header + footer shell.

## Data flow

`page → makeApi(VITE_API_BASE) → fetch public aggregator endpoint → render`. No writes, no
auth, no secrets. k-anon enforced server-side means nothing private can be exposed.

## Error handling

- API unreachable / non-2xx → a friendly "couldn't load" state per page (don't crash the app).
- Empty data (fresh aggregator) → the k-anon empty copy.
- A bad/unknown `:id` on the ingredient page → its sections render their own empty states (the
  API returns empty arrays; no 404 needed for M1).

## Testing

Vitest + `@testing-library/react`, mirroring the console:
- **Pure helpers** — port the existing `data.test.ts` cases for the copied helpers.
- **Leaderboard** — renders rows from stubbed `getPopularity`; search filters; empty state.
- **Ingredient detail** — fetches + renders co-occurrence + adoption from stubbed API.
- **Router** — `/ingredient/:id` resolves to the detail page with the decoded id.
- Stub `fetch` with the same `res(body)` pattern the console tests use.

## Deployment

- Cloudflare Pages project building `packages/marketplace` (static output) + the `_redirects`
  SPA fallback. Custom domain `app.agentgem.ai`. `VITE_API_BASE` set at build time.
- A short runbook (Pages setup + DNS + env) accompanies the implementation, like the Render one.

## Out of scope (later slices)

- **Network pulse strip** — needs `overview` added to `PUBLIC_READ_PATHS` (1 line + redeploy).
  Omitted from M1 to keep it zero-backend; a trivial follow-up if wanted.
- **Gem browse / detail (M1.5)** — needs a public, CORS-open gem/registry read API (or the SPA
  reading the GitHub registry index directly).
- **Accounts + starring / reviews / profiles (M2)** — OAuth (#28 account-binding) + a social
  backend.
- **Commerce / selling (M3)** — the data-moat "B2" tail.
- **Desktop "local-only" trim** — remove Insights + Get-Gems-browse from `packages/console`;
  separate PR, depends on choosing the canonical console across the divergence.
- **SSR/SEO** for indexable ingredient pages — would mean a different stack (deferred).
