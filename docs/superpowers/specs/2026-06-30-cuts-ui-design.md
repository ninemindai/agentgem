# Gemstone Cuts in the Marketplace (Gem Contributions #5-browse) — Design

**Date:** 2026-06-30
**Status:** Approved-pending-review — the browse/render half of subsystem #5 of the [Gem Contributions vision](2026-06-30-gem-contributions-vision-design.md)

## Goal

Make a gem's **cut** visible and navigable on `app.agentgem.ai`: render each gem with its cut's **gemstone-colored pill** (e.g. a pearl-tinted "Playbook"), and add a **cut filter facet** to the `/gems` browse page. Reads the `type` field that #3 already stores on the registry and surfaces on `RegistryGem` — no server change. The browse/render half; the publish-from-marketplace UI (which needs #4 account-bound publishing) is separate and later.

## Context (ground-truth)

- The marketplace (`packages/marketplace`, Vite/React SPA) is **standalone**: it talks only to the public API and **copies** pure helpers rather than importing server code (the local↔origin divergence dodge — see [[two-app-split-marketplace]]). So it needs its **own** cut→color table; it cannot import the server's `@agentgem/model` cuts / DI registry.
- The public API `GET /api/registry/gems` returns `RegistryGem` which **#3 extended with `type?`** (`src/gem/publicCatalog.ts`). The marketplace's mirror `RegistryGem` (`packages/marketplace/src/types.ts:1`) has `{key, version, author?, description?, tags?, artifactKinds?}` — **no `type` yet**.
- `loadGems(api)` (`packages/marketplace/src/gems/catalog.ts`) maps `RegistryGem → Gem` (the marketplace's `Gem` = `{key, version, author?, description, tags, artifactKinds, ingredients}`), falling back to `STATIC_GEMS` on empty/error. `findGem`/`filterGems` are the lookup/search helpers.
- Cards render on `pages/Gems.tsx` (browse) with a search box + `StarButton`; detail on `pages/Gem.tsx`. The CSS design system uses terracotta `#b4543a` + verified-green `#3a7d44` with an `.ex-chip` vocabulary for tags/artifactKinds.
- **Live-data reality:** the one live registry gem (`@ninemind/brainstorming-kit`) was published **before #3**, so its discovery has **no `type`** → it must render with **no cut badge** (graceful), until backfilled (a one-off, included as the last step).

## Decisions (settled in brainstorming)

- **Visual: a colored gemstone pill** — a small pill tinted by the cut's gemstone color, labeled with the cut name, shown alongside the existing artifactKind chips on cards + detail. (Not a gem emoji, not an accent stripe.)
- **Scope: badges + a cut filter facet** — render the badge everywhere AND add toggleable cut chips on `/gems` to filter by cut (combined with the existing search). Cuts become navigable.
- **Emerald ≠ verified-green:** the Skill cut's emerald pill uses a distinct emerald tint (lighter, different saturation) from the brand verified-green `#3a7d44`, and the pill style (filled tint + label) differs from the verified badge — so they don't read as the same token.
- **Graceful fallback:** a gem with no/unknown `cut` renders **no badge** (never mislabel); `STATIC_GEMS` get explicit cuts so the fallback catalog looks intentional.

## The cut→gemstone-color table (marketplace-local)

`packages/marketplace/src/gems/cuts.ts` (new, pure) — the 6 built-in cuts mirrored from the server's vocabulary, with light-tinted pill backgrounds + saturated label colors (accessible on the light shell, distinct from each other and from verified-green):

| cut id | label | gemstone | pill bg | label fg |
|---|---|---|---|---|
| playbook | Playbook | Pearl | `#ece9f5` (pale pearl) | `#5b4b8a` |
| setup | Setup | Opal | `#dbf1ec` (pale opal-teal) | `#1f7a6a` |
| kit | Kit | Amethyst | `#efe6f7` | `#8e44ad` |
| skill | Skill | Emerald | `#d8f0e3` | `#1f7a52` |
| integration | Integration | Sapphire | `#dde7f6` | `#2f5fa0` |
| guide | Guide | Topaz | `#f7ecd0` | `#a9760a` |

`export const CUTS: Record<string, { label: string; gemstone: string; bg: string; fg: string }>` + `export function cutMeta(cut?: string) { return cut ? CUTS[cut] ?? null : null; }` (unknown/undefined → `null` → no badge). Pure; trivially testable. (Colors are tunable in review; the *structure* is the contract.)

## Components (files)

- **`packages/marketplace/src/types.ts`** — add `type?: string` to `RegistryGem`.
- **`packages/marketplace/src/gems/cuts.ts`** (new) — `CUTS` + `cutMeta`.
- **`packages/marketplace/src/gems/catalog.ts`** — add `cut?: string` to `Gem`; in `loadGems`'s map add `cut: g.type`; add an explicit `cut` to each `STATIC_GEMS` entry (brainstorming-kit→kit, tdd-starter→kit, debugging-pro→skill, github-flow→integration, ship-it→kit, browser-pilot→integration, fullstack-starter→setup — match the gem's nature); add a `cut` arg to `filterGems` (or a sibling) so the page can narrow by cut.
- **`packages/marketplace/src/CutBadge.tsx`** (new) — `CutBadge({ cut })`: looks up `cutMeta(cut)`; renders `null` if none; else a `<span className="ex-cut">` pill with the gemstone bg/fg + label. `title={`${gemstone} · ${label}`}` for the gemstone name on hover.
- **`packages/marketplace/src/pages/Gems.tsx`** — render `<CutBadge cut={gem.cut} />` on each card (beside the artifactKind chips); add a **cut facet row**: toggleable chips for the cuts present in the loaded gems; selecting cuts narrows the list (AND with the search box). The card invariant from starring still holds (badge is not inside the row `<a>`).
- **`packages/marketplace/src/pages/Gem.tsx`** — render `<CutBadge cut={gem.cut} />` by the title.
- **`packages/marketplace/src/styles.css`** — `.ex-cut` pill (inline-flex, small radius, the per-cut bg/fg applied via inline style) + the `.ex-cut-facet` row (selected/unselected chip states), consistent with the existing `.ex-chip` sizing.

## Backfill (one-off, last step)

The live `@ninemind/brainstorming-kit` entry predates #3 → no `type`. Backfill it so the cut renders live: edit `registry.json` in the `ninemindai/agentgem-registry` repo to add `"type": "kit"` to that item's `discovery` (a direct JSON edit + commit via `gh`, since re-publishing the same version+digest is a no-op that wouldn't update discovery). Then the live `/gems` shows the pearl/amethyst pill on the real gem.

## Testing

- **`cuts.ts`:** `cutMeta("playbook")` → the pearl meta; `cutMeta("bogus")` → `null`; `cutMeta(undefined)` → `null`; `CUTS` has the 6 ids.
- **`catalog.ts`:** `loadGems` threads `cut: g.type` (a live gem with `type:"integration"` → `Gem.cut === "integration"`; a live gem with no `type` → `cut` undefined); `STATIC_GEMS` each have a valid `cut`; the cut filter narrows correctly (AND with search; empty selection = all).
- **`CutBadge`:** renders the label + a title for a known cut; renders nothing (`null`) for undefined/unknown.
- **`Gems` page:** a gem with a cut shows the badge; the facet row toggles narrow the list; a gem without a cut shows no badge.
- Gates: `pnpm --filter @agentgem/marketplace test | typecheck | build`.

## Out of scope

- Server changes (#3 already ships `type`).
- The **rating / gem-count** half of the Stone axis (needs gem-adoption telemetry — a later subsystem).
- Publish-from-marketplace UI (needs #4).
- A cut filter on the ingredient leaderboard (leaderboard is ingredients, not gems).

## Risks

- **Pale gemstones (Pearl/Opal) on a light shell** — low contrast; mitigated by a saturated label color + a subtle border on the pill (add `border: 1px solid` a slightly darker shade if review finds them washed out).
- **Emerald vs verified-green confusion** — mitigated by a distinct emerald tint + different pill styling; flag in review if they still read alike.
- **Live gem shows no badge until backfilled** — expected; the backfill step closes it. The marketplace static rebuild + the API already serving `type` (post-#3 deploy) are the two live preconditions.
- **Hot file:** `packages/marketplace` is concurrently active (starring, CSS) — additive diffs, keep the card-anchor invariant.
