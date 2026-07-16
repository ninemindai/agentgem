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

- `byProject: { name: string; sessions: number; tokens: number }[]`
  — summed over the uncapped `filtered` set, sorted desc by tokens.
  `project === null` buckets as `"(no project)"`.
- `topSessions: { agent: AgentId; sessionId: string; project: string | null; model: string | null; tokens: number; endMs: number }[]`
  — top 8 by `tokensOf(s)` from the uncapped `filtered` set.

Mirror both fields in `ObservePayloadSchema` in
`packages/console/src/api/routes.ts` (the two ObservePayload types — insight's
interface and the routes `z.infer` — stay structurally compatible). The server's
`/api/observe` route calls the same aggregator, so it returns the new fields with
no server change.

### UI changes (`packages/console/src/panels/Observe/Dashboard.tsx`)

A new two-card row below the main charts row (`obs-charts`), visually matching the
existing `UsageBars` cards (name + proportional bar + value) but with values
formatted via `fmtTokens` instead of raw counts:

- **"Tokens by project"** — top 8 of `data.byProject`. Clicking a project row
  applies the existing project filter: `onFilter({ ...filter, project })`. The
  `"(no project)"` bucket is not clickable (there is no `project === null` facet
  filter value). The whole dashboard then scopes to that project — same mechanism
  the `ObserveFilters` chips already use.
- **"Top sessions"** — `data.topSessions`, rows labeled
  `project-basename · model · sessionId-prefix…`, clicking deep-links to
  `#/sessions/<agent>/<sessionId>` (the established drill-down route).

Both cards hide when their list is empty, respect range/filter automatically
(derived from `filtered`), and reuse existing `obs-card` / `obs-usage-*` CSS.
New CSS only if a real visual gap shows up in the browser.

No session picker on Overview.

## Testing

- `packages/insight` `observeAggregate` tests: project bucketing incl. null
  project, tokens-desc ordering, and a case with >200 sessions proving
  `byProject`/`topSessions` see past the recency cap.
- `packages/console` `Observe.test.tsx`: cards render from payload; project row
  click updates the filter; session row click navigates to
  `#/sessions/<agent>/<id>`.
- Console tests do not run in CI — run locally.
- Verify styled rendering in a real browser (project verify skill), not just jsdom.
