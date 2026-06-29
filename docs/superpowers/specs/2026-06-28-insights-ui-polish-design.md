# Insights UI polish — Design

**Date:** 2026-06-28
**Status:** Approved (brainstorm). Spec 1 of the data-sharing **exposure** track.

**Goal:** Make the Insights leaderboard easier to navigate (search) and connect it to
acquisition (deep-link an ingredient into Get Gems), as fast-follows to the shipped
Insights panel (#42).

## Context

The Insights panel (`packages/console/src/panels/Insights/`) is on `origin/main`: a
trusted-adoption leaderboard (`popularity`) with a network pulse (`overview`) and a
per-ingredient drill-in (`co-occurrence` + `adoption`). The public-read aggregator
endpoints under `/api/aggregator` are CORS-open and k-anon-floored server-side.

This spec ships two of the v1-deferred follow-ups from the Insights UI design
(`2026-06-28-console-insights-ui-design.md`): **search within the leaderboard** and
**linking an ingredient row to Get Gems**.

### Dropped from scope (with reason)

- **Exposing `attestations.trust_score`.** Confirmed binary today: `schema.ts` defaults
  it to `1`; `detection.ts` sets it to `0` only on quarantine; and every aggregate already
  filters `not quarantined`. So every row visible in Insights has `trust_score = 1` —
  there is nothing meaningful to surface. Real exposure is blocked on graded
  reputation-weighting (a deferred trust-spine item). Revisit when that lands.

## Decisions (locked in brainstorming)

1. **Search is a pure client-side filter.** `popularity()` already returns the full ranked
   set above the k-anon floor in one call, so search filters the already-loaded `rows` —
   no new request, no backend change.
2. **Rank numbers stay tied to full-list position.** When the list is filtered, each row
   keeps the rank it holds in the unfiltered leaderboard (so "#7" stays honest). Rank is the
   index into the original `rows`, not the filtered view.
3. **Deep-link via a module-store intent, not a URL query.** `Shell.tsx` matches
   `p.route === hash` by **exact equality** — `#/get-gems?q=foo` would not match and would
   fall back to the first page. So cross-panel intent is passed through a tiny module-level
   store (mirroring the existing active-gem / `resetGem` pattern) and navigation uses the
   clean `#/get-gems`. Tradeoff: not a shareable/bookmarkable URL — acceptable, the console
   has no other shareable deep-links and the router has no query support.
4. **Deep-link prefills a text search, honestly.** The registry search is text-based over
   names/tags/descriptions — it is **not** indexed by ingredient. So the deep-link prefills
   the ingredient's human name and runs the existing text search; it is a discovery
   shortcut, not a precise "gems that use `skill:X`" query. Ingredient-indexed discovery is
   a later registry change, out of scope here.

## Components

### 1. Leaderboard search

- **`data.ts` — `filterRows(rows, query)` (new, pure).** Case-insensitive substring match
  over each row's prettified `name`, `scope` (via `prettifyId`), and raw `id`. Empty/blank
  query returns `rows` unchanged. Order preserved (already ranked).
- **`index.tsx`** owns a `search` state string (lifted, alongside `kind`/`selectedId`), and
  passes `filterRows(rows, search)` to `Leaderboard` along with `search`/`onSearch`.
- **`Leaderboard.tsx`** renders a search `<input>` above the rows (`aria-label="search ingredients"`),
  and renders rank from the row's original index. When the filtered list is empty but a
  query is present, show an `ins-empty` "No ingredients match" message (distinct copy from
  the existing k-anon empty state).

### 2. Cross-panel deep-link

- **Intent module (new, e.g. `packages/console/src/panels/GetGems/intent.ts`).** A minimal
  module-level holder: `setPendingQuery(q: string)`, `takePendingQuery(): string | null`
  (returns and clears). No React, no store library — same shape as the existing gem store.
- **`Detail.tsx`** adds a "Find Gems using this →" button in the detail header. On click:
  `setPendingQuery(head.name)` then `window.location.hash = "#/get-gems"`.
- **`GetGems/index.tsx`** on mount calls `takePendingQuery()`; if non-null, sets `q` and
  triggers `search()` once (then it's cleared so re-visiting Get Gems is clean).

## Data flow

```
Insights Detail row
  └─(click "Find Gems using this →")─> setPendingQuery(name) ; hash = "#/get-gems"
GetGems mount
  └─ takePendingQuery() -> q := name ; search()  (intent cleared)
Leaderboard search box
  └─ onSearch(text) -> index state -> filterRows(rows, text) -> rendered rows (ranks from full list)
```

## Error handling

- Search: no I/O, nothing to fail. Blank/whitespace query is a no-op (full list).
- Deep-link: if Get Gems' registry is not configured, the term IS prefilled into the search
  box (so the user sees what they clicked), but only the search call is gated on readiness;
  the existing "Registry not configured" message is shown beneath it.
- `takePendingQuery()` returning `null` (normal navigation) leaves Get Gems behavior unchanged.

## Testing

- **`data.test.ts`** — `filterRows`: matches on name, on scope, on raw id; case-insensitive;
  blank query returns all; no-match returns empty; order preserved.
- **`Leaderboard.test.tsx`** — typing in the search box narrows the rendered rows; ranks
  reflect original positions; no-match shows the "No ingredients match" empty state.
- **Intent + GetGems** — `setPendingQuery`/`takePendingQuery` round-trips and clears;
  a GetGems component test asserts that with a pending query it prefills the input and runs
  the search, and that takePendingQuery is one-shot (second mount is clean).

## Out of scope (later)

- Ingredient-indexed registry discovery (precise "gems using `skill:X`").
- Pinning/compare across ingredients; pagination beyond the server `limit`; real-time refresh.
- `trust_score` / graded reputation exposure (blocked, see above).
- The other exposure-track specs: API keys + rate limits (gating), and the hosted cloud deploy.
