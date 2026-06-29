# Console Insights UI (#42) — Design

**Goal:** A console page that makes the aggregator data-moat legible — a trusted-adoption
leaderboard of ingredients with a network-pulse overview and per-ingredient drill-in
(co-occurrence + adoption growth) — surfacing the `verifiedProducers` trust signal (#42).

**Status:** Design approved via brainstorming. Next: implementation plan.

## Context

The producer→aggregator→trust→insights backend is on `main`. Three public-read endpoints
exist under `/api/aggregator`; no console UI consumes them yet. This builds that UI plus one
small new backend endpoint (`/overview`) for honest network totals.

### Backend already shipped (consumed as-is)

All public-read (CORS-open, `originGuard`-exempt), k-anonymity floor `DEFAULT_K = 5`
enforced server-side (callers cannot lower it):

- `GET /api/aggregator/popularity?kind?&limit?` →
  `{ id, kind, producers, verifiedProducers, invocations, sessions }[]` (ranked by producers desc).
- `GET /api/aggregator/co-occurrence?id&limit?` →
  `{ id, producers, verifiedProducers }[]` (ingredients used alongside `id`).
- `GET /api/aggregator/adoption?id&bucket?(week|month)` →
  `{ bucket, producers, verifiedProducers, invocations }[]` (per-bucket, point-in-time).

`producers` = distinct ed25519 producer pubkeys. `verifiedProducers` = distinct
`provider:account_id` pairs from `account_bindings` (GitHub-bound, signature-verified) — the
trust signal. Implemented as pure functions in `src/aggregator/aggregates.ts`, wired by the
decorator controller `src/aggregator.controller.ts` (`@api({ basePath: "/api/aggregator" })`).

### Ingredient ids are human-readable (key feasibility fact)

Public ingredient ids are self-describing (`src/gem/canonicalize.ts`); private ones are
salted and never reach the aggregator (`public: false`, filtered at ingest):

- skill (plugin): `skill:<plugin>/<name>` · skill (registry): `<source>` (`@scope/...`)
- mcp (package): `<runner>:<pkg>` (e.g. `npx:@modelcontextprotocol/server-github`)
- mcp (url): `url:<hostname>` · mcp (plugin): `mcp:<plugin>/<name>`
- model: lowercased id (`claude-opus-4-8`) · harness: `claude-code` / `codex`

So the UI needs **no name-resolution backend** — only prefix-stripping + a `kind` badge.

## New backend: `GET /api/aggregator/overview`

Honest network totals for the pulse strip (no per-ingredient exposure, so safe to aggregate).
Public-read, same pattern as the others.

**Response:** `{ ingredients, producers, verifiedProducers, invocations, sessions }` (all `number`).

**Query** (pure fn `overview(db, { k })` in `src/aggregator/aggregates.ts`), over the same
non-quarantined usage base the leaderboard uses so numbers are coherent:

```sql
select
  count(distinct e.ingredient_id)::int                              as ingredients,
  count(distinct a.producer_pubkey)::int                            as producers,
  count(distinct b.provider || ':' || b.account_id)::int            as "verifiedProducers",
  coalesce(sum(e.invocations), 0)::int                             as invocations,
  coalesce(sum(e.sessions), 0)::int                               as sessions
from usage_edges e
join attestations a on a.id = e.attestation_id and not a.quarantined
left join account_bindings b on b.pubkey = a.producer_pubkey
```

**K-anonymity:** safe-by-default consistent with the codebase — if `producers < k` (DEFAULT_K),
the whole network is below the floor; return all-zero counts (the UI shows a "not enough
producers yet" pulse rather than tiny exact totals). Caller cannot pass `k` over HTTP.

Controller: add `@get("/overview", { response: OverviewResult })` returning `overview(db, {})`.

## Console UI

### Placement & files

`InsightsPage` — `id: "insights"`, title **Insights**, icon a chart glyph, `group: "library"`,
`order: 25` (between Your Gems `20` and Get Gems `30`), `route: "#/insights"`.

`packages/console/src/panels/Insights/`:
- `index.tsx` — page shell: pulse strip + master-detail (leaderboard left, detail right);
  owns `selectedId` state + data fetching.
- `data.ts` — **pure, unit-tested**: `prettifyId(id, kind)` → `{ name, scope? }`;
  `kindLabel(kind)`; `verifiedShare(producers, verified)` → 0..1; `barWidths(rows)` (relative);
  `sparkPoints(series)` → SVG path/points.
- `Leaderboard.tsx` — kind-filter tabs + ranked rows.
- `Detail.tsx` — co-occurrence list + adoption chart for the selected id.
- `Sparkline.tsx` — hand-rolled SVG (no dependency).
- Tests: `data.test.ts`, `Insights.test.tsx`.

### Data layer (`api/routes.ts`)

Four new typed routes (`defineRoute` + Zod response schemas matching the shapes above):
`popularityRoute`, `coOccurrenceRoute`, `adoptionRoute`, `overviewRoute`. Called via the
existing `makeClient(apiBase)` + `route.call(client, { query })` pattern.

### Network pulse (top strip)

From `overviewRoute`: "**N ingredients · M producers · K verified (P%)**" with a verified-share
mini-bar and total invocations. Below-floor → "Not enough producers yet."

### Leaderboard (left)

Loads `popularity` on mount. Kind-filter tabs: **All / Skill / MCP / Model / Harness**
(All omits `kind`; others pass it). Each row:
- prettified name (+ scope subtitle), a `kind` badge,
- a relative-width bar (producers vs the max in view),
- **"N producers · M verified ✓"** with a small verified-share bar.
Ranked by producers desc (server default). Clicking a row sets `selectedId`.

### Detail (right)

On `selectedId`, fetches `co-occurrence` + `adoption` (default `bucket: "week"`, toggle to
month). Shows:
- **header**: prettified name + kind badge + prominent **verified badge** (the #42 ask),
- **Used together with**: prettified co-occurring ingredients with producer/verified counts,
- **Adoption**: SVG sparkline of producers per bucket with verified overlaid; invocations as a
  secondary line/label; week|month toggle.
Empty selection → a hint ("Select an ingredient to see how it's used and growing").

### Craft

Hand-rolled SVG charts (no new dep). Letterpress palette: producers in `--accent`, verified in
`--emerald`, invocations in `--gold`/muted. `prefers-reduced-motion` respected. Loading
skeletons; per-panel error messages; if the aggregator DB is unconfigured the endpoints error →
the page shows "Insights unavailable" rather than crashing.

## Error / edge handling

- **Below k-anon floor / empty**: friendly empty states (pulse, leaderboard, detail each).
- **Fetch error**: inline, panel-scoped (leaderboard error doesn't blank the pulse).
- **Selected id with no co-occurrence/adoption** (sole producer, below floor): "Not enough
  data yet" in that sub-panel.

## Testing

- **Backend**: `overview()` query test (counts/distinct/sum; below-floor → zeros) following
  `src/aggregator/__tests__/aggregates.test.ts`; controller route test if the controller suite
  covers the others.
- **Console pure** (`data.test.ts`): `prettifyId` across all id shapes (skill/mcp/url/model/
  harness, with/without scope), `verifiedShare`, `barWidths`, `sparkPoints` (incl. empty/single).
- **Console component** (`Insights.test.tsx`, `vi.stubGlobal` fetch): pulse renders from
  overview; leaderboard renders ranked rows; kind filter re-queries; selecting a row fetches +
  renders detail (co-occurrence + adoption); below-floor/empty + error states.

## Out of scope (v1)

- Search within the leaderboard; pinning/compare across ingredients.
- Linking an ingredient row to Get Gems/Curate (cross-panel deep-link) — fast-follow.
- Exposing `attestations.trust_score` (only the binary verified signal ships now).
- Real-time refresh; pagination beyond the server `limit`.
