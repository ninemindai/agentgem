# Observe panel — local agent-session analytics

_Spec. 2026-06-28. Branch `feat/observe-panel`._

## Goal

A new left-rail console panel, **Observe**, that gives the user a complete
analytic view of their interactions with coding/co-working agents (Claude Code
and Codex). Charts for daily activity, token usage, session length/busyness, and
model mix — read from local session transcripts, single-user, no network.

Success criteria:

- A new `Observe` page is reachable from the left rail (its own group, above Build).
- It renders, from **real local transcript data**, at minimum: a "today" pulse,
  a daily-activity chart, a token-usage chart, a sortable session table, and a
  model-share chart.
- Data covers **both** Claude Code and Codex sessions through one normalized shape.
- A time-range selector (`Today / 7d / 30d / All`) re-scopes every widget.
- No raw message text ever leaves the transcript files — counts and timestamps only.

Non-goals (deferred to a later pass):

- The share-highlights / "aha moments" / copy-to-tweet layer (the original
  social-sharing ask). It will ride on this same data later.
- Any network/aggregator integration. Observe is local-first.
- Per-message drill-down or transcript viewing.

## Strategy fit

This is the **local-first, single-user bootstrap** of the recommendation/insight
surface described in the biz strategy (`recommendation-engine.md`: "local
single-user signal first … available day one, no network required"). Observe
earns the data and the habit; the share/monetize layer is built on top of it
afterward (`social-sharing-virality.md`: trophy-not-goldmine highlights).

## Architecture

Two layers, mirroring the existing `workflowScan` → panel split.

### Backend: `observeScan.ts` (new module) + one route

A new module that walks both transcript stores and emits one normalized record
per session. It is **separate** from `workflowScan.ts` (which is per-project and
artifact-centric); Observe is global and usage/timing-centric.

Sources:

- Claude: `~/.claude/projects/**/*.jsonl` — usage at
  `message.usage.{input_tokens, output_tokens, cache_read_input_tokens,
  cache_creation_input_tokens}`, per-record `timestamp`, `sessionId`, `cwd`,
  `message.model`, record `type` (`user` / `assistant`).
- Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` — usage keys
  `input_tokens / output_tokens / cached_input_tokens / reasoning_output_tokens`,
  per-record `timestamp`, `session_meta` for id/model, `time_to_first_token_ms`.

Normalized shape (the only thing charts consume):

```ts
interface SessionStat {
  agent: "claude" | "codex";
  sessionId: string;
  project: string | null;   // basename of cwd, or null (Codex may lack cwd)
  model: string | null;
  startMs: number;          // first record timestamp
  endMs: number;            // last record timestamp
  msgs: number;             // user + assistant message records
  tokensIn: number;         // input (+ cache-read folded in for Claude? see decisions)
  tokensOut: number;        // output (+ reasoning for Codex)
  tokensCache: number;      // cache creation/read (Claude); cached_input (Codex)
  firstReplyMs: number | null; // median user→assistant latency proxy (TTF for Codex)
}
```

Privacy boundary: the parser reads `usage`, `timestamp`, `model`, `type`, and
`cwd` only. It NEVER retains message text — identical boundary to `workflowScan`
(coordinates/counts only).

Route: `observeRoute` — defined as a route object in
`packages/console/src/api/routes.ts` (the shared client/server contract, same as
the existing routes consumed via `makeClient`) and handled server-side in
`src/index.ts` (the RestServer). Aggregation happens **server-side**: the handler
reads `SessionStat[]`, buckets by the requested range, and returns a compact
payload:

```ts
interface ObservePayload {
  pulse: { sessions: number; msgs: number; tokens: number; activeMs: number };   // "today" (or range head)
  daily: { date: string; sessions: number; msgs: number;
           tokensIn: number; tokensOut: number; tokensCache: number }[];          // one per day in range
  sessions: { agent; sessionId; project; model;
              durationMs; msgs; tokens; endMs }[];                                 // for the table, capped/sorted
  models: { model: string; agent; sessions: number; tokens: number }[];           // model-share
  range: "today" | "7d" | "30d" | "all";
}
```

Sending aggregates (not raw `SessionStat[]`) keeps the wire small and keeps the
privacy boundary on the server.

### Frontend: `panels/Observe/` (new panel via the existing seam)

Registered with `defineConsolePage` and added to the `pages` array in
`pages.tsx` — same one-import-one-entry seam every other panel uses. New nav
**group** `observe`, ordered above `build`, icon `👁`. This requires two small
supporting edits, since groups are currently hardcoded to `build` / `library` /
`settings`:

- `registry.ts` `groupedPages()` — add an `observe` bucket.
- `shell/Shell.tsx` — render the `observe` group (with its label) above the
  `Build` group.

(Simpler fallback if a dedicated group is undesirable: register Observe in the
existing `library` group with a low `order`. The dedicated-group route is the
default for the "look before you act" placement the user asked for.)

Files:

- `panels/Observe/index.tsx` — page wrapper: fetches `observeRoute` for the
  selected range, owns the range state, renders `<Dashboard>`.
- `panels/Observe/Dashboard.tsx` — layout: `Pulse`, `ActivityChart`,
  `TokenChart`, `SessionTable`, `ModelShare`.
- `panels/Observe/data.ts` — pure transforms from `ObservePayload` to chart
  props (testable without React).
- `panels/Observe/*.test.tsx` / `data.test.ts` — unit tests.

Charts use **Recharts** (`recharts`, added to `packages/console`): `BarChart`
(daily activity), stacked `AreaChart` or `BarChart` (token in/out/cache over
time), `PieChart`/donut (model share). The session table is plain HTML, sortable
by duration / msgs / tokens. Range selector is a simple segmented control.

Dependency note: Recharts is a new dependency in `packages/console`. Justified —
the project has **no charting primitive at all** on this branch, and the
dashboard needs axes, stacks, tooltips, and a donut. Recharts is the standard
React dashboard charting lib and is React 19-compatible. (uPlot was the lighter
alternative; Recharts chosen for DX over the ~100KB bundle cost on a local
single-user console.)

## Data flow

```
~/.claude/projects/**        observeScan.ts          observeRoute            Observe panel
~/.codex/sessions/**   ──►   parse + normalize  ──►  bucket by range   ──►   fetch(range) ──► Recharts
                             → SessionStat[]          → ObservePayload        + SessionTable
```

## Error handling

- Missing/unreadable transcript dir → empty `SessionStat[]`, panel shows an
  empty state ("No agent sessions found yet."). Never throws (matches
  `workflowScan`/`acpRecommender` total-function posture).
- Malformed JSONL lines are skipped individually.
- A transcript with no usage records still contributes timing/msg counts;
  token charts simply show zero for it.
- Route failure → panel shows an inline error state (same pattern other panels
  use for failed route calls).

## Testing

- `observeScan`: fixture Claude + Codex JSONL (a few lines each) → assert
  normalized `SessionStat` fields (tokens summed, duration = end−start, msgs
  counted, model picked up, project from cwd). Assert malformed lines skipped and
  missing dirs → empty.
- `observeRoute` aggregation: given a `SessionStat[]`, assert daily buckets,
  pulse totals, model-share, and range filtering (`today`/`7d`/`30d`/`all`).
- `data.ts`: payload → chart props transforms.
- Panel: renders pulse + charts from a mocked route; range change refetches;
  empty + error states.

## Decisions locked

- v1 covers **Claude + Codex** via the normalized shape (flavor seam).
- v1 is **dashboard only**; share-highlights deferred.
- **Recharts** for charts.
- **Global** view across all projects/agents; per-session rows in the table are
  the drill-down (no per-message view).
- `tokensCache` is reported as its own series (not folded into in/out) so the
  cache vs fresh-token story stays visible.
