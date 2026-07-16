# Overview: token usage by top projects and sessions

**Date:** 2026-07-16
**Status:** Approved

## Problem

The Overview dashboard (`#/overview`, `packages/console/src/panels/Observe/`) shows
*that* tokens were spent (pulse total, daily token area chart, by-model pie) but not
*where*. There is no breakdown by project or by session, so a user who burned 40M
tokens this week cannot see which project or which sessions did it without paging
through the Sessions table manually.

A session picker on Overview was considered and rejected: Overview is the aggregate
view, Sessions is the per-session ledger (the split is codified in
`panels/Observe/index.tsx`). Instead, top-session rows deep-link into the existing
Sessions detail page.

## Design

Two ranked token-breakdown cards on the Overview, derived inside
`aggregateObserve` (NOT in the Dashboard component).

### Why derive in `aggregateObserve`

`aggregateObserve` (`packages/insight/src/observeAggregate.ts`) caps the payload's
`sessions` array at the 200 most recent by `endMs`. Per-project token totals and
"top sessions by tokens" must be computed over the **uncapped** filtered set —
a token-heavy session from 3 weeks ago can fall off the recency cap in a 30d range.
Deriving client-side from `data.sessions` would silently truncate.

### Data changes

Add to insight's `ObservePayload` interface and the aggregation loop in
`aggregateObserve`:

- `byProject: { project: string | null; sessions: number; tokens: number; tokensIn: number; tokensOut: number; tokensCache: number }[]`
  — summed over the uncapped set, sorted desc by tokens. **Row identity is
  `project: string | null` (eng review, 6A)** — the `"Unassigned"` label and the
  non-clickable affordance are derived AT RENDER from `project === null`, never
  baked into the data. (`project` values are cwd basenames, so a real folder
  named `Unassigned` must stay distinguishable from the null bucket.)
- `topSessions: { agent: AgentId; sessionId: string; project: string | null; model: string | null; tokens: number; tokensIn: number; tokensOut: number; tokensCache: number; endMs: number }[]`
  — top 8 by `tokensOf(s)` from the uncapped `filtered` set.

**Token metric (approved, 8A):** ranking and displayed values use the same
`tokensOf() = in + out + cache` as the pulse, tokens chart, and by-model pie —
one definition of "tokens" page-wide. Composition is exposed via the row
tooltip (in/out/cache split), and the `· N%` share makes concentration legible.

Mirror both fields in `ObservePayloadSchema` in
`packages/console/src/api/routes.ts` (the two ObservePayload types — insight's
interface and the routes `z.infer` — stay structurally compatible). The server's
`/api/observe` route calls the same aggregator, so the new fields flow through at
runtime automatically; the server's own schema copy is synced for contract
honesty (next two sections).

**Schema contract (approved, 2A; rationale corrected by eng review, 5A):** both
fields are `.default([])` in the console Zod schema. Who this protects: consumers
of `/api/observe` — SessionPicker and friends — whose client-side response parse
would otherwise REJECT an old server's payload (missing required fields) under
the known SPA-cached-at-boot version skew. The Overview cards themselves are
never at risk: they are derived client-side from `/observe/raw` by the same
bundle that defines the schema.

**Server schema sync (eng review, 2A + 5A):** the THIRD schema copy lives in
`src/gem.controller.ts` and is the OpenAPI contract; it has already drifted on
BOTH endpoints. This change syncs both and exports them:

- `ObservePayloadSchema` (`gem.controller.ts:26`): add the four pre-existing
  missing fields (`byTool`/`bySkill`/`bySubagent`/`usageDaily`) plus
  `byProject`/`topSessions`.
- `SessionStatSchema` (`gem.controller.ts:37`, the `/observe/raw` contract): add
  the optional `tools`/`skills`/`subagents`/`cwd` fields insight and the console
  raw schema already declare.
- **Export both** (currently module-private consts) so the drift-guard test can
  import them.

Runtime never depended on this (the server validates responses but never strips —
`@agentback/rest` logs debug and returns the raw object), so this is contract
honesty, not a behavior fix.

### UI changes (`packages/console/src/panels/Observe/Dashboard.tsx`)

**Placement (approved, 1B):** a new named section **"Where tokens went"** —
inserted between the main `obs-charts` row (Activity / Tokens / By model) and the
conditional `byTool/bySkill/bySubagent` block, OUTSIDE that conditional (it renders
whenever sessions exist, even if tool/skill counts are empty). Section header uses
the compact card-title idiom (uppercase, muted — a small heading line above the
row, not prose). Scan order becomes: pulse → how much/when/what model → **where**
→ what artifacts. Card order: "Tokens by project" first (left), "Top sessions"
second (right).

The two cards visually match the existing `UsageBars` cards (name + proportional
bar + value) but with values formatted via `fmtTokens` instead of raw counts:

- **"Tokens by project"** — top 8 of `data.byProject`. Clicking a project row
  applies the existing project filter: `onFilter({ ...filter, project })`. The
  `"Unassigned"` bucket (9A) is not clickable (there is no `project === null` facet
  filter value): rendered as a plain muted `<span>` — no link color, no pointer —
  with `title="sessions with no project metadata — not filterable"`. The whole
  dashboard then scopes to that project — same mechanism the `ObserveFilters`
  select already uses.

  **Filter interaction (approved design, Variant B — facet-style):** `byProject`
  is computed BEFORE the project filter is applied — a partial-filter aggregate
  inspired by (not identical to) the `facets` pattern in `aggregateObserve`:
  facets skip ALL attribute filters, while `byProject` applies
  agent/model/minMsgs and skips only project (see the data-flow diagram below).
  So when a project is active, the card keeps the full ranking: the active row is
  highlighted (bold name + emerald bar via an `is-active` class), the card title
  gains a small "`<project> ✕`" clear chip, clicking the active row or the chip
  clears the filter, and clicking another row switches to it. All other cards and
  charts (including Top sessions) stay scoped by the global filter as usual.
- **"Top sessions"** — `data.topSessions`, clicking a row deep-links to
  `#/sessions/<agent>/<sessionId>` (the established drill-down route), with
  **both segments `encodeURIComponent`-encoded** (eng review, 7A — the existing
  convention in `MomentCard.tsx:26` and `HygieneLeaderboard.tsx:25`).

**Row presentation (approved, 5A):**

- Project rows: value renders as `38.2M · 71%` — `fmtTokens` plus percent share.
  **Denominator (eng review, 1A): `Σ byProject[].tokens`** — the same
  pre-project-filter set as the ranking, NOT the pulse total (which shrinks under
  an active project filter and would push other rows past 100%). Shares always
  sum to ~100%; they intentionally diverge from the pulse stat while a project
  filter is active. Guard: when `Σ tokens === 0` (all-zero-token sessions in
  range) omit the `· N%` segment rather than render `NaN%` — covered by a test.
  Tabular-nums, muted. Bars stay proportional to the top row.

  Aggregation data flow (eng review):

  ```
  rangeStats (endMs ≥ since)
        │
  attrFiltered = rangeStats · agent/model/minMsgs   ← NO project filter
        │                        │
        │                        └─ filtered = attrFiltered · project
        │                                │
  byProject (ranking + share            everything else: pulse, daily, models,
  denominator, "Unassigned" bucket)     byTool/bySkill/bySubagent, topSessions
  ```
- Session rows are TWO lines. Line 1: project basename (terracotta link) +
  right-aligned `fmtTokens` value. Line 2 (muted, smaller): `model · id-prefix ·
  relative date` — 8-char sessionId prefix + `…`, relative date from `endMs` via
  the EXISTING tested helper `util/timeAgo.ts` ("2h ago" / "3d ago") — do NOT
  add a new `fmtAgo` (eng review, 7A). Null fallbacks: project → "Unassigned"
  text, model → "—" (both existing conventions).
- Value tooltip on both cards: `title="41.2M — 1.2M in · 890K out · 39.1M cache"`
  (requires `tokensIn/Out/Cache` on `byProject` rows and `topSessions` rows).

**Component + CSS (approved, 6A):** a new small `BreakdownCard` component in
`panels/Observe/` — a sibling of `UsageBars` mirroring its DOM shape and visual
language, NOT a generalization of it (UsageBars' three call sites stay
untouched). New classes, all authored in `theme.css` in the same change, all
from existing tokens (no new colors):

- `.obs-breakdown-charts` — the section's grid: `repeat(auto-fit, minmax(300px, 1fr))`,
  two columns on desktop, stacks on narrow — avoids the auto-fill ghost-column
  bug a two-card row would hit in `.obs-charts`.
- `.obs-breakdown-head` — card header row: title left (existing `obs-card-title`
  style), clear chip right.
- `.obs-breakdown-chip` — the "`<project> ✕`" clear chip: `var(--paper-2)` bg,
  `1px var(--line)` border, `var(--ink-soft)` text, pill radius — quiet next to
  the uppercase muted title.
- `.obs-usage-row.is-active` — selected project row: bold name,
  `var(--emerald)` bar fill (selection, distinct from the terracotta default),
  `aria-current="true"`.
- `.obs-breakdown-meta` — session row line 2: muted 11px metadata.

**Accessibility & responsive (approved, 7A):** every interactive row and the
clear chip are native `<button>`s inheriting the global `:focus-visible` ring —
do not substitute divs. Clear chip: `aria-label="Clear project filter"`. Active
project row: `aria-current="true"`, with bold name as the non-color cue beside
the emerald bar. Session-row hit target spans both lines (~34px — dense desktop
app; acceptable for this desktop-first local console). Muted 11px metadata keeps
the dashboard-wide `--muted` convention; its sub-4.5:1 contrast is a THEME-level
question tracked in TODOS.md, not fixed per-card. Responsive: the
`.obs-breakdown-charts` grid stacks to one column under ~640px via
`auto-fit/minmax` — no separate mobile layout.

**State coverage (approved, 3A):**

| State | Tokens by project | Top sessions |
|---|---|---|
| Loading / refresh | inherits the dashboard `pending` pill + `.is-updating` dim — no separate skeleton (none exist on this page) | same |
| Empty (no sessions in range) | whole-dashboard `obs-empty` handles it; section not rendered | same |
| Degenerate (only bucket is "Unassigned") | card hidden — a single unclickable bar answers nothing | n/a |
| Filter empties the list | keeps full list (computed pre-project-filter) | card STAYS MOUNTED with muted in-card line "No sessions in this range" (precedent: `obs-usage-series-empty`) — no layout jump |
| Stale server payload | `.default([])` → cards hidden, rest of dashboard unaffected | same |

No session picker on Overview.

**Round-trip persistence (approved, 4A):** Overview's `range` + `filter` state
persists to `sessionStorage` and rehydrates on mount, so the triage loop (click a
top session → Sessions detail → back → next session) keeps its investigation
context. sessionStorage (not localStorage) so a fresh browser session starts
clean. **Rehydration is validated (eng review, 3A):** parse under try/catch;
`range` accepted only from the 4-value enum; `minMsgs` only as a finite number;
anything else falls back to the defaults (`"7d"`, `{ minMsgs: 100 }`) and is
overwritten on next save. A stale persisted `project` passes through — the ✕
clear chip is the recovery affordance. The browser-verify checklist includes this round trip, and also confirms
that a project-row click's dashboard-wide rescope is perceivable from the cards'
scroll position (the `is-updating` dim + chip are the feedback).

## Testing

- `packages/insight` `observeAggregate` tests: project bucketing incl. null
  project ("Unassigned"), tokens-desc ordering, percent-share math, and a case
  with >200 sessions proving `byProject`/`topSessions` see past the recency cap;
  byProject computed pre-project-filter (facet-style) while agent/model/minMsgs
  still apply.
- `packages/console` `Observe.test.tsx`: cards render from payload; project row
  click updates the filter; active row shows `aria-current` + clear chip; chip
  click clears; session row click navigates to `#/sessions/<agent>/<id>`;
  Top sessions stays mounted with empty line under an active filter; range/filter
  rehydrate from sessionStorage.
- **Eng-review additions (4A + mandatory regression):**
  - share denominator = `Σ byProject[].tokens` while a project filter is ACTIVE
    (shares of non-active rows stay ≤100% and sum to ~100%) — insight test;
  - clicking the ACTIVE project row clears the filter (the other half of
    Variant B) — console test;
  - "Unassigned" row renders as a plain `<span>`, not a `<button>` — console;
  - only-Unassigned data → project card hidden (3A degenerate state) — console;
  - **drift-guard**: `aggregateObserve` output `safeParse`s cleanly against the
    SERVER `ObservePayloadSchema` (gem.controller.ts) — root test; makes the
    three-schema drift class unreproducible;
  - old-payload fixture (no byProject/topSessions) parses via `.default([])`,
    cards hidden — console (formalizes T2's verify);
  - **CRITICAL regression**: fresh mount with empty sessionStorage keeps today's
    defaults (`7d`, `minMsgs: 100`) — console.
- Console tests do not run in CI — run locally (`tsc -b` first; root tests run
  from `dist/`).
- Verify styled rendering in a real browser (project verify skill), not just
  jsdom — including: the section reads correctly at the approved position, the
  filter round trip (Overview → Sessions → back) preserves range/filter, and the
  rescope-on-click is perceivable without scrolling.

## What already exists (reuse, don't reinvent)

- `obs-card`, `obs-card-title`, `obs-usage-row/head/name/count/track/fill/link`
  — the visual language both cards mirror.
- `ObserveFilters` project `<select>` — the global filter the project rows drive;
  selecting "All projects" is the always-available undo.
- `fmtTokens`, `fmtDuration` (`panels/Observe/data.ts`); `obs-usage-series-empty`
  (in-card empty-line precedent); the global `:focus-visible` ring idiom;
  `pending` pill + `.is-updating` dim for refresh states.
- `facets` in `aggregateObserve` — the pre-filter computation pattern that
  inspired Variant B's `byProject` (a partial-filter variant: agent/model/minMsgs
  still apply).
- `util/timeAgo.ts` — existing tested relative-time helper; Top-sessions rows
  reuse it (no new fmtAgo).
- Lapidary Ledger tokens (`--paper/--raised/--line/--accent/--emerald/--muted`)
  — no new colors are introduced.

## NOT in scope (considered, deferred)

- **Session picker on Overview** — rejected; Overview stays aggregate, Sessions
  owns per-session drill-down.
- **Null-project ("Unassigned") filterability** — deferred (9A); conditional
  TODO if the bucket proves dominant in real usage.
- **Theme-wide muted-text contrast fix** — the sub-4.5:1 `--muted` at 11px is a
  dashboard-wide convention; tracked as a theme-level TODO (7A), not a per-card
  fork.
- **Ranking by in+out ("work" tokens)** — rejected (8A) to keep one page-wide
  definition of "tokens"; composition lives in the tooltip.
- **Cost-in-dollars column** — never requested; token counts are the console's
  established unit.
- **Placement above the main charts (Codex 1A)** — rejected in favor of 1B to
  preserve the page's established temporal scan order.

## Implementation Tasks

Synthesized from the 2026-07-16 design review's findings. Each task derives from
a specific finding above. Checkbox as you ship.

- [ ] **T1 (P1, human: ~3h / CC: ~20min)** — insight — extend `aggregateObserve`
      with `byProject` (pre-project-filter facet-style, "Unassigned" bucket,
      in/out/cache sums) and `topSessions` (top 8 by tokens, token fields, endMs)
  - Surfaced by: original spec + Pass 7 (8A metric, 9A bucket) + Variant B
  - Files: `packages/insight/src/observeAggregate.ts` + its tests
  - Verify: insight tests incl. the >200-session cap case
- [ ] **T2 (P1, human: ~45min / CC: ~8min)** — schemas — mirror both fields in
      the console `ObservePayloadSchema` with `.default([])`; sync + export the
      server `ObservePayloadSchema` and `SessionStatSchema` (2A + 5A)
  - Surfaced by: Pass 2 issue 2 + eng review issues 2/5
  - Files: `packages/console/src/api/routes.ts`, `src/gem.controller.ts`
  - Verify: old-payload fixture parses; drift-guard test imports both server schemas
- [ ] **T3 (P1, human: ~4h / CC: ~45min)** — console UI — `BreakdownCard`
      component + "Where tokens went" section at the 1B position, 5A row
      presentation, Variant B active-filter interaction, 9A Unassigned row,
      3A state handling
  - Surfaced by: Passes 1–5 (issues 1, 3, 5, 6) + Variant B
  - Files: `packages/console/src/panels/Observe/BreakdownCard.tsx` (new),
    `Dashboard.tsx` (reuse `util/timeAgo.ts` for relative dates — 7A)
  - Verify: Observe.test.tsx additions listed under Testing
- [ ] **T4 (P1, human: ~1h / CC: ~10min)** — theme — author the five
      `.obs-breakdown-*` / `is-active` rules from existing tokens
  - Surfaced by: Pass 5 issue 6 (6A class enumeration) + CLAUDE.md
    CSS-enforced-classname rule
  - Files: `packages/console/src/shell/theme.css`
  - Verify: `grep -c` each new class in theme.css > 0
- [ ] **T5 (P2, human: ~1h / CC: ~10min)** — console UI — persist Observe
      `range`+`filter` to sessionStorage, rehydrate on mount
  - Surfaced by: Pass 3 issue 4 (4A round-trip)
  - Files: `packages/console/src/panels/Observe/index.tsx`
  - Verify: unit test + browser round-trip check
- [ ] **T6 (P1, human: ~2h / CC: ~15min)** — tests — the console + insight test
      additions enumerated under Testing
  - Surfaced by: Testing section (review-expanded)
  - Files: `packages/console/src/panels/Observe/Observe.test.tsx`, insight tests
  - Verify: run locally — console tests are NOT in CI
- [ ] **T7 (P2, human: ~30min / CC: ~10min)** — verify — real-browser pass:
      styled render at the 1B position, filter round trip, rescope
      perceivability from card scroll position
  - Surfaced by: Pass 3 (4A checklist) + Pass 6
  - Files: none (verification)
  - Verify: project `verify` skill run

_No new tasks from Pass 4 beyond T3's row presentation; no new tasks from the
outside voices beyond those folded into T1–T4. Eng review folded the schema-sync
and test additions into T2/T6; whole-change effort recalibrated to ~2–3h CC
(7A) — the original ~1h total was optimistic._

## Approved Mockups

| Screen/Section | Mockup Path | Direction | Notes |
|----------------|-------------|-----------|-------|
| Where tokens went (2 cards) | ~/.gstack/projects/ninemindai-agentgem/designs/overview-token-cards-20260716/design-sketch.html | Variant B — facet-style persistent list, active row highlighted, ✕ clear chip | HTML wireframe from real theme tokens (AI image backend unavailable); default state approved with relative dates + tooltips; row presentation upgraded post-approval by 5A (two-line session rows, percent share) |

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | (outside voices ran inside both reviews below) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 8 issues, 0 critical gaps, all folded |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | CLEAR (FULL) | score: 6/10 → 9/10, 10 decisions |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **CODEX:** outside voice ran in both reviews — design stage: 7 findings → decisions 1B/5A/6A/8A/9A; eng stage: 9 findings, 7 verified-and-folded (share denominator path, raw-endpoint schema drift, `project: string|null` row identity, encodeURIComponent convention, private-schema export, timeAgo reuse, estimate recalibration), 1 wording fix, 1 tension resolved keep-as-is (8B).
- **CROSS-MODEL:** design stage converged on placement/labels/CSS; eng stage's one genuine tension (validate Unassigned prevalence before Variant B polish) was resolved for the current approach — projects derive from cwd, 9A TODO is the escalation.
- **VERDICT:** DESIGN + ENG CLEARED — ready to implement.

NO UNRESOLVED DECISIONS
