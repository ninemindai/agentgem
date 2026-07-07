# Session History: hover summary + click-to-open-transcript

**Date:** 2026-07-07
**Status:** Approved (design)
**Area:** `packages/console/src/panels/Sessions/` (+ `panels/Observe/TranscriptViewer.tsx`)

## Problem

The History ledger (`#/sessions`) hides everything behind an inline expand: clicking
a session row toggles a detail panel, and the only way to reach the full transcript
is a secondary "Open transcript →" button inside that panel. The summary is gated
behind a click, and opening the transcript takes two clicks.

We want to invert this:

- The per-session summary should appear **on hover** (a peek), not behind a click.
- The **click** should be freed up to open the transcript directly.

## Goals

1. Hovering (or keyboard-focusing) a row reveals a deterministic **activity skeleton**
   summary for that session.
2. Clicking a row (or Enter/Space) navigates straight to the transcript.
3. Remove the inline expand entirely.
4. Nothing is lost: the detail the expand used to show relocates to the transcript.

## Non-goals

- No LLM-generated prose summary. The hover is a deterministic, content-free skeleton.
- No process-quality label / edits-verifications skeleton (that needs `summarizeSession`
  + a new endpoint + fetch-on-hover). Explicitly deferred to a possible later spec.
- No change to the transcript route, `parseSelection`, or `TranscriptDiff`.

## Interaction model

Per row in `SessionsTable.tsx`:

- **Hover or focus → summary popover.** A small anchored popover shows the activity
  skeleton: top tools by count plus skill/subagent counts, e.g.
  `Edit×20 · Bash×8 · Read×12 · 2 skills · 1 subagent`. Focus (not just mouse hover)
  also triggers it so it is reachable without a mouse.
- **Click or Enter/Space → open transcript.** Sets
  `window.location.hash = "#/sessions/<agent>/<sessionId>"` — the same navigation the
  old "Open transcript →" button performed. `TranscriptViewer` renders the destination.
- **Inline expand removed.** No caret column, no `openId` state, no expanded detail row.
  Row at rest = the ledger columns; hover/focus = summary; click = transcript.

## Data flow (no backend change)

- `index.tsx` already holds the raw `stats: SessionStat[]` from `useObserveData()`.
  Each `SessionStat` carries per-session `tools` / `skills` / `subagents` count maps,
  populated by `observeScan` (`packages/insight/src/observeScan.ts`). The table currently
  receives only the *aggregated* `ObservePayload`, which drops those per-session maps.
- `index.tsx` builds a lookup — `Map<string, { tools; skills; subagents }>` keyed by
  `` `${agent}:${sessionId}` `` — from the raw `stats` and passes it to `SessionsTable`.
- The popover reads counts from that in-memory map. **No new endpoint, no fetch-on-hover,
  no loading state.**
- Empty maps (no recorded tools) → the popover shows `No recorded tool activity`, not an
  empty box.

## Relocating the old expand's detail

The old expanded panel showed: token in/out/cache breakdown, absolute start→end
timestamps, git branch, model, agent, truncated sessionId, and the transcript button.

- model / agent are already in the `TranscriptViewer` header subtitle; sessionId is in the
  URL — no action needed for those.
- The genuinely-new fields to surface in the transcript header (`TranscriptViewer.tsx`,
  `.tv-head`, currently `model · duration · msgs · tokens`) are:
  **tokens in / out / cache breakdown, absolute start→end timestamps, and git branch.**

Net: nothing is lost; the detail relocates to the destination the row now opens in one click.

## Components & isolation

- **`SessionsTable.tsx`** — remove caret column, `openId` state, and the expanded detail
  row; `COL_COUNT` 8 → 7. Add row-level click + Enter/Space navigation and hover/focus
  handlers that drive the popover. Keep existing columns, sorting, and the flame indicator.
- **New `SessionSummaryPopover.tsx`** (same folder) — pure presentational component:
  input `{ tools: Record<string, number>; skills: Record<string, number>; subagents:
  Record<string, number> }`, output the formatted skeleton string / node. No data-fetching,
  independently testable. Handles top-N ordering, singular/plural, and the empty state.
- **`index.tsx`** — build and pass the counts lookup; leave `parseSelection` and the
  transcript sub-route untouched.
- **`TranscriptViewer.tsx`** — extend `.tv-head` to surface tokens in/out/cache, absolute
  start→end, and git branch.

## Edge cases & error handling

- Session in the aggregated table but missing from the raw `stats` lookup (shouldn't happen,
  same source) → popover falls back to `No recorded tool activity`.
- Empty tool/skill/subagent maps → same fallback.
- Popover positioning must not overflow the viewport on the last rows; anchor so it stays
  on-screen (open upward near the bottom).
- Keyboard: row is a focusable, role-appropriate element; Enter/Space opens the transcript;
  focus reveals the popover; Escape/blur hides it.

## Testing

- `SessionsTable.test.tsx`:
  - Row click sets the hash to `#/sessions/<agent>/<sessionId>`.
  - Enter and Space on a focused row do the same.
  - No expanded detail row / caret exists anymore.
  - Hover/focus renders popover content with formatted counts for that session.
  - Empty-counts session renders the fallback text.
- `SessionSummaryPopover.test.tsx`: top-N ordering, singular vs plural ("1 skill" /
  "2 skills"), and the empty state.
- Console tests are not in CI (repo convention), so run `pnpm test` + typecheck locally in
  `packages/console` before finishing.

## Risks

- Low. No backend, no schema, no new network calls. The only cross-file change outside
  `Sessions/` is additive header fields in `TranscriptViewer.tsx`.
