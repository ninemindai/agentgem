# Watch: alert when a session is waiting for input

**Date:** 2026-07-16
**Status:** Approved

## Problem

When a watched coding session hits a permission prompt, it blocks silently until
the user notices. The Watch tab shows the live feed, but nothing actively tells
the user "this session is stuck waiting on you." The user wants an alert when a
session is waiting for input — specifically for **permission prompts** (a tool
call sitting unanswered), not for ordinary turn-end idles.

## Decisions (from brainstorming)

- **Trigger:** permission prompts only — an unmatched `tool_call` with a stalled
  transcript. Turn-end idles stay silent.
- **Delivery:** the existing notify pipeline (toast focused / OS notification
  backgrounded) **plus** a visual badge in the Watch tab.
- **Scope:** the user selects which active sessions alert — a few or all.
  Default: all.
- **Approach:** server-side transcript heuristic (approach A). A Claude Code
  `Notification`-hook push was considered (precise, but Claude-only and needs
  per-machine hook install) and rejected for now; the endpoint's response shape
  can absorb a hook-sourced signal later without UI changes.

## Design

### Server: `src/watchAttention.ts` + `GET /api/watch/attention`

**Detection (pure function).** Given the folded `SessionEvent[]` for a
transcript, its `mtimeMs`, and `now`:

- `pending` — at least one `tool_call` has no matching `tool_result` (paired by
  `toolId`; calls with `toolId: null` are **excluded** — they are unpairable, as
  in SessionFeed's fold, and counting them would flag a permanent false pending)
  **and** `now - mtimeMs >= 25_000` (stall threshold).
- `busy` — unmatched tool_call but the file is still fresh (< 25s).
- `idle` — no unmatched tool_call (last activity is a message).

Multiple unmatched calls are one `pending` state, keyed on the **first**
unmatched tool_call's event index; further results landing without fully
clearing the set do not produce a new key.

**Endpoint.** `GET /api/watch/attention` (originGuard, registered in
`appCommon.ts` beside the other watch routes). No params. Runs over
`listActiveSessions()` (existing 6h window, ≤30 sessions) and returns:

```json
{ "sessions": [ {
    "id": "…", "file": "/abs/path", "agent": "claude", "project": "…",
    "state": "pending" | "busy" | "idle",
    "pendingKey": 41,            // first unmatched tool_call index (pending only)
    "pendingToolName": "Bash",   // pending only
    "stalledMs": 32000
} ] }
```

**Cost control.** Fold results are cached per file by `mtimeMs`. A stalled
file's mtime doesn't change, so steady-state polls cost one `statSync` per
session; only a changed file re-folds.

**Honest wording.** The transcript cannot distinguish a permission prompt from
a long-running tool. State is named `pending` and all user-facing copy hedges:
"waiting on approval (or a long tool run)".

### Console: notify wiring

- `notify/events.ts` gains pure `detectAttention(prev, next, enrolled)` →
  `NotifyEvent[]`, same transition-snapshot pattern as `detectWarm`/`detectDream`.
  - Fires only for sessions whose file is in `enrolled`.
  - Fires on transition into `pending` (per `pendingKey`); event key is
    `attention-<sessionId>-<pendingKey>` so one stall alerts exactly once, and a
    later distinct stall in the same session alerts again.
  - First snapshot (`prev === null`) is silent (baseline, mirrors detectWarm).
  - Title: `Session needs your input`; message:
    `<project> — waiting on approval for <tool> (or a long tool run).`
- `NotificationsProvider` adds `/api/watch/attention` to its existing 5s poll
  and routes through the existing `dispatch` (toast when focused, `osNotify`
  when hidden), gated by the existing global notify pref. A failed poll leaves
  baselines untouched.

### Console: selection + badge (Watch tab)

- `notify/watchAlertPrefs.ts` (idiom of `prefs.ts`): localStorage-persisted
  `{ mode: "all" | "selected", files: string[] }`, default `{ mode: "all" }`.
  `NotificationsProvider` resolves `enrolled` from prefs × the attention
  response each poll.
- Watch session list: a bell toggle per session row (enrolls/unenrolls; master
  "all sessions" switch flips mode), and a "⏸ needs input" badge on any
  `pending` session regardless of enrollment. The feed header shows the same
  badge when the open session is the stalled one.
- Every new className added in `.tsx` gets a matching rule in the console
  stylesheet in the same change; styled UI verified in a real browser.

## Edge cases

- **Abandoned sessions** (killed mid-tool-call): stay `pending` in the
  transcript, alert at most once, and age out of discovery via the 6h window.
- **Already-stalled at console start:** silent (first-snapshot baseline).
- **Notification permission:** unchanged — existing Electron bridge / web
  Notification handling in `osNotify`.

## Testing

- Server: unit tests for the detector (pending/busy/idle folds, null-toolId
  calls excluded, 25s boundary, mtime cache) alongside existing watch tests;
  endpoint smoke test with a temp transcript.
- Console: `detectAttention` transition tests and `watchAlertPrefs` round-trip
  in `notify/__tests__`, following `events.test.ts` / `prefs.test.ts` patterns.
  Console tests run locally (CI skips packages/console — known gap).

## Out of scope

- Turn-end idle alerts.
- Claude Code Notification-hook ingestion (future precision upgrade; response
  shape already accommodates it).
- Any change to the SSE feed endpoints.
