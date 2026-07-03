# Unified GitHub Identity — Sub-project 3: Author links (`@login` → `/@login`) across gem surfaces

Date: 2026-07-03
Status: Design — pending user review
Branch: `feat/identity-author-links` (off `origin/main` @ 81d0203)

## Context

Sub-project 3 (final) of the unified-identity effort. SP1 (PR #87) reconciled the
console binding with the web `accounts` row and surfaced the avatar in Settings.
SP2 (PR #92) built the public profile page at `app.agentgem.ai/@<login>`. SP3
makes gems *point at* those profiles: a clickable `@login` byline on every gem
surface, linking to the SP2 profile.

**Decomposition recap:** 1 = reconcile + avatar (shipped, #87), 2 = profile page
`/@login` (shipped, #92), 3 = **this** — author links everywhere.

### The identity to link: `publishedBy`, not `author`

Every gem carries two author-ish fields:
- **`author`** — a free-text label from the manifest (e.g. "superpowers",
  "ninemind"). Not a GitHub identity; cannot be trusted to resolve to a profile.
- **`publishedBy`** — the **verified, server-derived GitHub login**, set from
  `account_bindings` on catalog-share (`recordCatalogShare`, `catalog.ts:65`) or
  from the signed-in session on publish (`uploadPublish.ts:70`). Never
  client-supplied. This is the identity SP2 profiles are keyed on.

SP3 renders a linked `@publishedBy` byline when `publishedBy` is present, and
falls back to the **unlinked** free-text `author` (or nothing) when it is absent
(e.g. the curated `STATIC_GEMS`, or index-only gems). Link when we have verified
identity; degrade to plain text when we don't. Never render a broken link.

### Avatar depth (decided during brainstorming)

**Author links only** — a clickable `@login` byline. The avatar *image* lives on
the SP2 profile page, not inline on every card. No new avatar-lookup endpoint,
no per-list avatar round-trip.

### Where `publishedBy` already flows (verified on this branch)

- **Marketplace** (`GET /api/registry/gems` → `RegistryGemSchema`,
  `src/schemas.ts:775`): `publishedBy` is **already on the wire**. DB-shared
  catalog gems reliably carry it (`mapDbToGems` ← `CatalogRow.publishedBy`,
  `publicCatalog.ts`). The marketplace **client** drops it: the client
  `RegistryGem` (`packages/marketplace/src/types.ts`) has no `publishedBy`, and
  `toGem` (`gems/catalog.ts:109`) does not thread it into `Gem`.
- **Console** (`GET /api/registry/search` → `RegistrySearchResponseSchema`,
  `src/schemas.ts`): results have `author` but **no `publishedBy`**. The search
  path reads the registry **index** (`searchIndex(getIndex())`,
  `gem.controller.ts:966`), and `RegistryItemDiscoverySchema`
  (`src/schemas.ts:749`) has no `publishedBy` field. So the console cannot show a
  verified author link until `publishedBy` is threaded through the index
  discovery + search response.

## Design decision

Two independent slices, shipped in order. **Slice A (marketplace) is this plan's
implementation scope.** **Slice B (console) is a documented fast-follow** whose
first task gates on a data-availability check.

Rejected: an inline-avatar approach on every card (adds a batch avatar endpoint /
per-list round-trip for marginal value — the profile page already shows the
avatar); linking the free-text `author` (unverified, would 404 for org labels
like "superpowers").

### Dependency on SP2 (#92)

SP3 only adds `href="/@<login>"` values; it does **not** add the `/@login`
Router match (SP2 did). On a checkout without SP2 merged, the hrefs are correct
but navigation resolves to the Leaderboard fallback until #92 lands. Tests assert
href correctness (route-independent), so SP3 is developable and testable
independently; the links go *live* once #92 merges.

## Slice A — Marketplace author links (implementation scope)

Client-only. `publishedBy` is already served; thread it to the two gem surfaces.

**Changes:**
- `packages/marketplace/src/types.ts` — client `RegistryGem` gains
  `publishedBy?: string` (mirrors the already-present server
  `RegistryGemSchema.publishedBy`).
- `packages/marketplace/src/gems/catalog.ts` — the `Gem` interface gains
  `publishedBy?: string`; `toGem(r)` threads `publishedBy: r.publishedBy`. The
  curated `STATIC_GEMS` leave it unset (→ author fallback).
- `packages/marketplace/src/pages/Gem.tsx` — the meta byline
  (`{gem.author && <span>by {gem.author}</span>}`) becomes: when
  `gem.publishedBy`, render `<a href={"/@" + encodeURIComponent(gem.publishedBy)}>@{gem.publishedBy}</a>`;
  else keep the existing unlinked `by {gem.author}` (or nothing if neither).
- `packages/marketplace/src/pages/Gems.tsx` — each browse card gains a byline
  (there is none today): when `g.publishedBy`, a `@publishedBy` link to
  `/@login`; else nothing (cards stay clean; no free-text author on cards).
  The link is a normal same-origin `<a href="/@…">` — App's click-interceptor
  navigates it via pushState.

**Testing (Slice A):**
- `gems/catalog.test.ts` — `toGem` maps `publishedBy` through; a `RegistryGem`
  without it yields a `Gem` with `publishedBy` undefined.
- `pages/Gem.test.tsx` — a gem with `publishedBy` renders an `@login` link whose
  href is `/@<login>`; a gem with only `author` renders the unlinked `by author`
  text; a gem with neither renders no byline.
- `pages/Gems.test.tsx` — a card for a gem with `publishedBy` shows a byline link
  to `/@login`; a gem without it shows no byline.

## Slice B — Console GetGems author link (documented fast-follow)

Higher cost (server + client) and a **data-availability gate**: the console
search reads the registry index, whose discovery metadata does not carry
`publishedBy` today.

**Task B0 (gating check):** confirm whether the registry **index write-path**
records `publishedBy` per item. Inspect the publish path
(`src/registry/uploadPublish.ts`, the index writer) and a real index. If it does
not, Slice B's links will be absent until the write-path is extended to record
`publishedBy` in each item's discovery block — that extension becomes B's first
implementation task.

**Changes (once B0 clears):**
- `src/schemas.ts` — `RegistryItemDiscoverySchema` and
  `RegistrySearchResponseSchema.results` gain `publishedBy: z.string().optional()`.
- `src/gem.controller.ts` `registrySearch` / `searchIndex` — thread `publishedBy`
  from index discovery into each result.
- `packages/console/src/api/routes.ts` — `RegistryResultSchema` gains
  `publishedBy?: string` (client/server parity).
- `packages/console/src/panels/GetGems/index.tsx` — when `r.publishedBy`, render
  `<a href={"https://app.agentgem.ai/@" + encodeURIComponent(r.publishedBy)} target="_blank" rel="noreferrer">@{r.publishedBy}</a>`
  (the console isn't the SPA — external link, matching the existing
  `target="_blank"` idiom used across console panels); else keep the current
  free-text `author` chip.

**Testing (Slice B):** the search handler carries `publishedBy` through from a
fixture index item; GetGems renders the external profile link when present and
the author-chip fallback when absent.

## Non-goals

- Inline avatar thumbnails on cards/listings (the avatar lives on the profile).
- Linking the free-text `author` (unverified).
- Any change to SP2's profile page or the `/@login` route (SP3 only produces the
  hrefs).
- A new avatar-lookup endpoint.

## Self-review

- **Placeholders:** none — every change names a real file/schema/field verified
  on this branch (`RegistryGemSchema.publishedBy`, `mapDbToGems`, client
  `RegistryGem`/`toGem`/`Gem`, `Gem.tsx` byline, `RegistryItemDiscoverySchema`,
  `RegistrySearchResponseSchema`, console `RegistryResultSchema`, GetGems).
- **Consistency:** `publishedBy` (verified login) is the linked identity on every
  surface; `author` (free text) is the unlinked fallback everywhere; links point
  at SP2's `/@login`.
- **Scope:** Slice A is a single, cohesive client-only plan (3 files + tests).
  Slice B is explicitly a fast-follow with a named gating check, not silently
  folded in.
- **Ambiguity:** "author links everywhere" pinned to `@publishedBy → /@login`
  with a plain-text `author` fallback; avatar depth pinned to links-only.
- **Dependency:** the `/@login` route is SP2's (#92); SP3 emits only hrefs, live
  once #92 merges.
