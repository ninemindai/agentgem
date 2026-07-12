# Miniapp search + tags/genre on app.agentgem.ai

**Date:** 2026-07-11
**Branch:** `feat/miniapp-search-tags`
**Scope:** one PR

## Problem

The public marketplace miniapps gallery (`packages/marketplace/src/pages/Minigames.tsx`)
loads every published `game` gem and renders them in a single flat grid — no search,
no filtering. As the catalog grows this is undiscoverable. We want a search box, a
structured **genre** facet, and **free-form tags**.

## Current state (verified)

- Gallery: `Minigames.tsx` calls `loadGems(api)` → `GET /api/registry/gems`, then
  `gems.filter(g => g.artifactKinds.includes("game"))`. No search/filter UI.
- A proven search+facet pattern already exists next door in `Gems.tsx`
  (`ex-search` input + toggle chips + `filterGems()` doing case-insensitive substring
  over key/description/tags). This is the template to adapt.
- `catalog_gems.tags jsonb` exists end-to-end (schema → `RegistryGem.tags` →
  client `Gem.tags`) **but the miniapp publish path never populates it** — published
  miniapps land with `tags = null`.
- Every miniapp has a `genre` (fixed enum `replay | skill-run | project-fun |
  session-heatmap`, canonical type `packages/model/src/types.ts:48`), but genre lives
  only inside the `.gem` archive bytes — it is **not** in the list payload, so it is
  not filterable without plumbing.

## Decisions

- **Tags meaning:** both — genre as the structured facet **and** free-form author tags.
- **Search engine:** client-side. The gallery already loads the full gem list; filter
  in the browser (adapt the `Gems.tsx` pattern). No new API endpoint. Fine to hundreds
  of miniapps; revisit at thousands.
- **Genre backfill:** yes — a one-time migration unpacks existing archives so the whole
  catalog is genre-filterable on day one.
- **Free-form tags UI:** rendered as small clickable chips on each card; clicking a chip
  adds it to the search query. No fixed tag rail (open-ended tags don't fit a fixed facet).
- **Ship as a single PR** (may contain multiple logical commits).

## Data flow

Authoring (local console/Studio) → aggregator Postgres → marketplace browse.

```
Studio publish dialog (tags input)
        │  share manifest.tags
        ▼
recordCatalogShare ──► catalog_gems.tags (jsonb)      [free-form tags]
        │  genre read from game artifact bytes
        ▼
recordCatalogShare ──► catalog_gems.genre (new col)   [structured facet]
        │
        ▼
GET /api/registry/gems  (RegistryGem: + genre, tags already present)
        │
        ▼
Minigames.tsx  (search box + genre chips + tag chips, client-side filter)
```

## Components

### 1. Storage — `packages/aggregator/src/schema.ts`

- Add `genre: text("genre")` to the `catalogGems` Drizzle def (~`:276`), nullable.
- In `ensureSchema` (~`:522`): `alter table catalog_gems add column if not exists genre text`.
- No new tags column — reuse the existing `tags jsonb`.

Genre gets a dedicated column (not folded into `tags`) because it's a fixed structured
facet distinct from open-ended keyword tags, and denormalizing it out of the archive
avoids unpacking archives on every list read.

### 2. Publish / write path

- **Genre** — in `recordCatalogShare` (`packages/aggregator/src/catalog.ts:222`), read
  the game artifact's `genre` from the archive bytes already in hand and store it in the
  new column. Single source of truth (the artifact), so it cannot drift from a manifest
  field. Non-game gems store `null`.
- **Tags** — add a tags input to the console Studio publish dialog
  (`packages/console`, alongside the existing `resolvePublishAction` / publish-status
  flow). Tags travel in the share manifest (`CatalogManifest.tags`, already supported)
  and are stored in the existing `tags` column by `recordCatalogShare`.
- `upsertCatalogGem` (`catalog.ts:22`) updated to carry `genre` through the merge/sync path.

### 3. API surface

Surface both fields in the existing `GET /api/registry/gems` payload (no new endpoint):

- `RegistryGemSchema` (`src/schemas.ts:906`): add `genre: GameGenreEnum.optional()`
  (reuse the existing enum; `tags` is already present).
- `CatalogRow` + `listCatalogGems` (`packages/aggregator/src/catalog.ts:13,40`): select
  the new `genre` column.
- `registryGems` / `mergeGems` (`src/gem.controller.ts:1267`): carry `genre` through.
- Client `RegistryGem` (`packages/marketplace/src/types.ts`) + `Gem`
  (`packages/marketplace/src/gems/catalog.ts:8`): add `genre?: GameGenre`.

### 4. Marketplace UI — `packages/marketplace/src/pages/Minigames.tsx`

Adapt the `Gems.tsx` pattern:

- `<input className="ex-search">` bound to a `query` state; matches key + description + tags.
- **Genre facet chips** — one toggle per genre value, analogous to `Gems.tsx`'s `cut`
  chips (`selectedGenres` set). Only genres present in the loaded set are shown.
- **Tag chips** — each card renders its tags as small clickable chips; clicking one sets
  the search query to that tag.
- A single pure helper `filterMiniapps(games, query, selectedGenres)`:
  - case-insensitive substring of `query` over key + description + tags, AND
  - `selectedGenres.size === 0 || selectedGenres.has(game.genre)`.
- Empty-state copy when filters match nothing.

### 5. Backfill migration

A standalone idempotent script under `packages/aggregator/src` (run once against prod):

- Select `catalog_gems` rows where `artifact_kinds ∋ "game"` and `genre is null`.
- For each, load the `.gem` archive from `gem_archives`, import it server-side (reuse the
  same import path `game-meta` uses in `aggregator.controller.ts`), read the artifact
  `genre`, write the column.
- Log rows scanned / updated / skipped. Safe to re-run.

## Error handling / edge cases

- Miniapp archive missing or unreadable during backfill → log and skip (leave `genre`
  null); does not abort the run.
- Publish of a gem with no game artifact → `genre` stays null (non-game gems).
- Genre value present in the archive but outside the enum → store null and log (guard
  against archive corruption / future values), so the marketplace never renders an
  unknown chip.
- Tags: cap count/length in the publish dialog (e.g. ≤ 8 tags, ≤ 24 chars each,
  lowercased/trimmed) to keep the chip UI sane. Reject empty/whitespace tags.

## Testing

- `filterMiniapps` unit tests: empty query; genre facet single/multi; tag substring
  match; combined query+genre; no-match empty state.
- Publish → list round-trip: a published miniapp's `genre` and `tags` appear in the
  `/api/registry/gems` payload.
- Backfill test: archive with genre X + null column → column becomes X; corrupt/missing
  archive → skipped, no throw.
- `Minigames` render/filter test (RTL): search box + genre chips filter the grid;
  clicking a tag chip narrows results. (Marketplace tests run in CI.)

## Enum drift note

Reuse the canonical `GameGenre` (`packages/model/src/types.ts:48`) and the existing
`GameGenreEnum` (`src/schemas.ts:108`). Do **not** add a new copy — the enum is already
duplicated across ~5 files (schemas.ts, archive.ts, marketplace/api.ts, console/routes.ts)
and that is the known drift risk.

## Out of scope

- Server-side search endpoint / pagination (revisit at thousands of miniapps).
- Editing tags of already-published miniapps without republishing (tags are populated
  on publish; genre is backfilled).
- Tag taxonomy / suggestions / autocomplete beyond a plain input.
