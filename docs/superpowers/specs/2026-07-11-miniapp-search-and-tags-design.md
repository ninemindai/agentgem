# Miniapp search + tags/genre on app.agentgem.ai

**Date:** 2026-07-11
**Branch:** `feat/miniapp-search-tags`
**Scope:** one PR

## Problem

The public marketplace miniapps gallery (`packages/marketplace/src/pages/Minigames.tsx`)
loads every published `game` gem and renders them in a single flat grid — no search,
no filtering (`Minigames.tsx:73`, a plain `.filter(g => g.artifactKinds.includes("game"))`).
As the catalog grows this is undiscoverable. We want a search box, a structured
**genre** facet, and **free-form tags**.

## Key discovery (drives the whole approach)

Every miniapp published through the console Studio **already carries its genre in the
catalog `tags` array**. `Studio.tsx:279` hardcodes `tags: ["game", <genre>]` on publish,
and that flows unchanged into `catalog_gems.tags` and back out through
`GET /api/registry/gems` → the marketplace client's `Gem.tags`. So the marketplace
already *receives* genre — it just doesn't *interpret* it.

Consequence: genre chips and search are a **client-side reading of data the gallery
already has**. No schema column, no migration, no backfill, no API plumbing. Existing
miniapps become genre-filterable immediately because they already carry the genre tag.

## Decisions

- **Tags meaning:** both — genre as the structured facet **and** free-form author tags.
- **Design shape: UI-only (Option B).** Genre is read from the tags the gallery already
  receives (the tag matching the 4-value genre enum). No aggregator/schema/API/backfill work.
- **Search engine:** client-side, adapting the proven `Gems.tsx` pattern (`ex-search`
  input + toggle chips + a pure filter helper).
- **Free-form tags authoring:** a tags input in the console Studio publish toolbar,
  merged into the publish tags array at `Studio.tsx:279`. **Publish-time only** — tags
  are not persisted into the archive's `meta.json` (that would pull in the model package
  and the save route; out of scope). Re-entered on republish.
- **Free-form tags UI:** each card renders its non-structural tags as small clickable
  chips; clicking one sets the search query. No fixed tag rail.
- **Reserved words:** the console tags input rejects/drops `game` and the 4 genre values
  so a free-form tag can never collide with the genre convention.
- **Ship as a single PR** (multiple logical commits).

## Data flow (nothing new server-side)

```
Studio publish toolbar
  scope radios + NEW tags input (setTags)
        │  publishSetupRoute body.tags = ["game", genre, ...userTags]
        ▼
publishSetup → manifest.tags → recordCatalogShare → catalog_gems.tags   [UNCHANGED chain]
        │
        ▼
GET /api/registry/gems  → Gem.tags (already carries ["game", genre, ...])
        │
        ▼
Minigames.tsx  (search box + genre chips + tag chips; genre + tags read from Gem.tags)
```

## Components

### 1. Console authoring — `packages/console/src/panels/Play/Studio.tsx`

- New state `const [tags, setTags] = useState<string>("")` (near `scope`, ~line 54).
- A tags `<input>` in the `play-studio-head` toolbar next to the `play-scope`
  radiogroup (~lines 344-348), `aria-label="tags"`, placeholder `"tags, comma separated"`.
- A pure, tested helper `parseTags(raw: string): string[]` (new file
  `packages/console/src/panels/Play/parseTags.ts`) that: splits on comma, trims,
  lowercases, drops empties, drops `game` and the 4 genre values (reserved), dedupes,
  and caps to ≤ 8 tags of ≤ 24 chars each.
- At publish, merge into the existing array:
  `tags: ["game", meta?.genre ?? "project-fun", ...parseTags(tags)]` at `Studio.tsx:279`.

No route/schema/manifest changes — `publishSetupRoute` (`routes.ts:797`),
`PlaybookPublishBodySchema` (`schemas.ts:584`), and the manifest already accept
`tags: string[]`.

### 2. Marketplace filter helpers — `packages/marketplace/src/gems/catalog.ts`

`Gem.tags: string[]` already exists (catalog.ts:14) — no interface change. Add pure,
tested helpers:

```ts
export const GAME_GENRES = ["replay", "skill-run", "project-fun", "session-heatmap"] as const;
export type GameGenreTag = (typeof GAME_GENRES)[number];
const GENRE_SET = new Set<string>(GAME_GENRES);

/** A game gem's genre, read from tags (publish writes ["game", <genre>, ...]). */
export function gameGenre(gem: Gem): GameGenreTag | undefined {
  return gem.tags.find((t): t is GameGenreTag => GENRE_SET.has(t));
}

/** Chip tags: everything except the structural "game" tag and the genre tag. */
export function displayTags(gem: Gem): string[] {
  return gem.tags.filter((t) => t !== "game" && !GENRE_SET.has(t));
}

/** Case-insensitive query over key + description + display tags, AND-ed with a genre facet. */
export function filterGames(games: Gem[], query: string, genres: string[] = []): Gem[] {
  const q = query.trim().toLowerCase();
  return games.filter(
    (g) =>
      (q === "" ||
        g.key.toLowerCase().includes(q) ||
        g.description.toLowerCase().includes(q) ||
        displayTags(g).some((t) => t.toLowerCase().includes(q))) &&
      (genres.length === 0 || genres.includes(gameGenre(g) ?? "")),
  );
}
```

Plus a tiny genre label map for chip display (marketplace can't import the console's):
`genreLabel(g)` → `"Session replay" | "Skill run" | "Project fun" | "Session heatmap"`.

### 3. Marketplace UI — `packages/marketplace/src/pages/Minigames.tsx`

Adapt the `Gems.tsx` pattern:
- `const [search, setSearch] = useState("")` and
  `const [selectedGenres, setSelectedGenres] = useState<string[]>([])`.
- `const presentGenres = [...new Set(games.map(gameGenre).filter(Boolean))]`.
- `const visible = filterGames(games, search, selectedGenres)`.
- Render an `.ex-search` input, a genre facet chip row (reuse `.ex-cut-facet` /
  `.ex-cut-toggle` / `.is-on`), a no-match empty state, and the existing grid over `visible`.
- In `GameCard`, render `displayTags(gem)` as clickable chips (reuse `.ex-tag`) that call
  `setSearch(tag)`.

### 4. Styling — `packages/marketplace/src/styles.css`

Reuse existing classes (`.ex-search`, `.ex-cut-facet`, `.ex-cut-toggle`, `.ex-tag`).
Add only small `.mg-`-scoped tweaks if spacing needs it (e.g. a `.mg-tags` chip row on the
card). No new design system work.

## Error handling / edge cases

- A miniapp with no genre tag (older/edge publish) → `gameGenre` returns `undefined`; it
  is simply absent from every genre facet and shows no genre chip. Never crashes.
- Empty search + no genre selected → all games (current behavior preserved).
- Free-form tag input: empties/whitespace dropped; reserved words (`game` + genres)
  dropped; capped (≤ 8 × ≤ 24 chars); deduped. All in `parseTags`.
- Clicking a tag chip whose text also appears in another card's description is fine — it's
  a substring search, intentionally broad.

## Testing

- `packages/marketplace/src/gems/catalog.test.ts`: `gameGenre` (present / absent / picks
  the genre not "game"), `displayTags` (strips game + genre, keeps user tags),
  `filterGames` (empty query, genre facet single/multi, tag substring, combined, no-match).
- `packages/marketplace/src/pages/Minigames.test.tsx` (extend existing, fetch-stub style):
  search narrows the grid; a genre chip filters; clicking a tag chip narrows. Stub gems
  must include `tags` like `["game","replay","puzzle"]`.
- `packages/console/src/panels/Play/parseTags.test.ts`: parsing, lowercasing, reserved-word
  drop, caps, dedupe. (Console tests run locally, not in CI — run them by hand.)

## Enum note

The 4 genre values live canonically at `packages/model/src/types.ts:48` (`GameGenre`) and
are duplicated in several files. This PR adds `GAME_GENRES` in the marketplace and reuses
the existing genre list in the console `parseTags` reserved set — do **not** add a new
enum copy in a shared package; these are local literal lists matching the canonical union.

## Out of scope

- Explicit `genre` column / server-side filtering / pagination (Option A — revisit at scale).
- Persisting free-form tags into the archive `meta.json` (would touch the model package,
  `MiniappMeta`, and `PlayMetaSchema`); tags are publish-time input for now.
- Editing tags without republishing; tag taxonomy / autocomplete.
