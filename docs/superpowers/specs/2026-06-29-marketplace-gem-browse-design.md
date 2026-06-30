# Marketplace Gem-Browse (M1.5) — Design

**Date:** 2026-06-29
**Status:** Approved (brainstorming) — ready for implementation plan

## Goal

Add public **gem browse + detail** pages to the marketplace (`packages/marketplace`, served at `app.agentgem.ai`). A gem is a composable bundle of ingredients (skills/MCPs/…). M1 shipped *ingredient* discovery (the aggregator leaderboard); M1.5 adds *gem* discovery on top, and ties the two together via cross-links.

## Context & key constraint

There is **no populated public gem catalog** today: the installable registry (`AGENTGEM_REGISTRY_REPO`) is unconfigured in prod, the share-card flow has no browse/list endpoint, and the aggregator tracks ingredients, not gems. Rather than block on standing up a public registry API + CORS + a populated repo, **M1.5 ships a curated static catalog** bundled into the marketplace build. This keeps M1.5 a pure frontend addition (no backend/CORS/registry work) and gets the pages live now. The catalog is shaped to mirror the eventual registry API so a live source drops in later behind one accessor.

There is also **no `agentgem add <key>` CLI command** (`src/cli.ts` has only `send`/`receive`/`bind`); registry installs happen through the desktop console's Get Gems panel. So the detail page presents getting a gem **honestly** — the gem key + the real console path — not an invented command.

## Architecture — static catalog behind an accessor seam

A bundled catalog module with a thin accessor, mirroring M1's `makeApi` seam so a future live registry API swaps in without touching the pages:

- `src/gems/catalog.ts` — exports a typed `GEMS: Gem[]` (the curated seed) and accessors `listGems(): Gem[]` and `getGem(key: string): Gem | undefined`.
- `Gem` shape (mirrors the registry's `RegistryResult` + detail fields):
  ```ts
  interface GemIngredient { id: string; kind: string }  // id is an aggregator id, e.g. "skill:superpowers/brainstorming"
  interface Gem {
    key: string;          // unique, url-safe (e.g. "brainstorming-kit")
    version: string;      // e.g. "1.2.0"
    author?: string;      // e.g. "superpowers"
    description: string;
    tags: string[];
    artifactKinds: string[];        // e.g. ["skill","mcp"] — chip row
    ingredients: GemIngredient[];   // bundled ingredients; ids match aggregator ids for cross-linking
  }
  ```
- **Seed content:** ~6–8 realistic gems built from **real** superpowers skills, so each `ingredients[].id` is a genuine aggregator ingredient id and its cross-link resolves to a live M1 ingredient page (which may show a k-anon empty state — that's fine, the link is valid).

## Pages & routing

Two new pages, plus header nav and two router routes. All reuse M1's brand shell, the global same-origin `<a>` SPA-nav interception (in `App.tsx`), `prettifyId`/`kindLabel` (`data.ts`), the search helper, and `styles.css`.

- **`/gems` — Browse** (`pages/Gems.tsx`): a client-side searchable list of gem cards. Each card shows key, description, tags, and kind chips; the whole card is an `<a href="/gems/<key>">`. Search filters case-insensitively over key + description + tags (a `filterGems(gems, query)` helper, analogous to M1's `filterRows`). Empty/no-match states mirror M1's Leaderboard.
- **`/gems/:key` — Detail** (`pages/Gem.tsx`): header (name from key, version, author, kind chips) · description · a **copy-able gem key** (`navigator.clipboard.writeText`) with the honest get-it steps ("open the AgentGem console → Get Gems → search this key → Install") · a **Contains** list of `ingredients`, each rendered with `prettifyId`/`kindLabel` and linking to `/ingredient/<encodeURIComponent(id)>` (the live M1 page). Unknown `:key` → a "gem not found" state (mirrors M1's error/empty pattern).
- **Header nav:** `App.tsx` gains an **Ingredients (`/`) ↔ Gems (`/gems`)** toggle, marking the active surface.
- **Router** (`Router.tsx`): extend the pathname matcher with `/gems/:key` → `Gem` (decoded key) and `/gems` → `Gems`, keeping `/` → Leaderboard and `/ingredient/:id` → Ingredient. Match order: `/gems/:key` before `/gems`.

## Data flow

Static, synchronous: `Gems` calls `listGems()` + `filterGems`; `Gem` calls `getGem(key)`. No `fetch`, no API base. Ingredient cross-links navigate (client-side) into M1's `Ingredient` page, which *does* fetch live aggregator data — so a gem's ingredients show real adoption when opened. This is the M1↔M1.5 tie-in.

## Out of scope (later slices)

- The live registry/CORS gem API — the `catalog.ts` accessor is the documented drop-in point (swap `listGems`/`getGem` to async API calls + add the endpoints to `PUBLIC_READ_PATHS`).
- Installing from the web; gem versioning/history; reviews/starring/auth (M2).
- A real `agentgem add` CLI command.
- Pulling seed gems from the actual registry (curated by hand for now).

## Testing

Vitest + jsdom, `.toBeTruthy()`/`.toBeNull()` assertions (no jest-dom), `vi.stubGlobal` where needed — matching M1.

- `catalog.test.ts` — `listGems()` returns the seed; `getGem(key)` hits + misses; `filterGems` narrows case-insensitively over key/description/tags and returns all on blank.
- `Gems.test.tsx` — renders gem cards from the catalog; search narrows; card links to `/gems/<key>`; empty-search → "no match" state.
- `Gem.test.tsx` — renders a known gem's fields + kind chips; the Contains list links each ingredient to `/ingredient/<encoded id>`; copy-key calls `navigator.clipboard.writeText` (stubbed); unknown key → not-found state.
- `Router.test.tsx` — `/gems` renders Gems; `/gems/<key>` renders Gem with the decoded key; existing `/` and `/ingredient/:id` still resolve.
- Full gate: `pnpm --filter @agentgem/marketplace test && … typecheck && … build`.

## Risks

- **Ingredient-id drift:** a seed `ingredients[].id` that doesn't match a real aggregator id still renders (the link just lands on an empty ingredient page) — low risk, cosmetic. Seed ids are chosen from real skills to minimize this.
- **`navigator.clipboard` in jsdom:** not implemented by default → the copy test stubs it (`vi.stubGlobal`/`Object.defineProperty`), and the component guards the call.
