# Studio resume — live progress (transcript-poll)

**Date:** 2026-07-16
**Status:** Design approved, ready for implementation plan
**Scope:** client-only (`packages/console`). No server/core changes.

## Problem

The desktop app keeps showing **"Resuming…"** for the Studio view with the chat
composer disabled, and it never recovers on its own.

### Root cause (confirmed by reading)

When the Studio panel mounts, `loadStudioSession()` reads
`GET /api/chat/:id/state`. If it reports `{ alive: true, running: true }`, the
panel enters a resume state (`Studio.tsx:136`):

```js
if (r.running) { setBusy(true); setWorking("resuming…"); pollWhileRunning(r.chatId!); }
```

It then polls `/state` every 1.5s and only clears when the server reports
`running: false` (`Studio.tsx:151-169`). Two problems:

1. **Frozen placeholder.** During resume the panel shows only a static
   "Resuming…" spinner and the last-loaded transcript — no indication the agent
   is still working, even though it genuinely is. The resume path polls `/state`
   for a boolean but never refreshes the transcript, so nothing on screen moves.

2. **Permanent lock (confirmed defect).** The poll caps at
   `POLL_MAX ≈ 10 min` (`Studio.tsx:165`):

   ```js
   if (++ticks >= POLL_MAX) { setWorking(""); setStatus("agent still running — press Stop to end it"); return; }
   ```

   This clears the spinner *text* but **never calls `setBusy(false)`**. The
   composer's Send is `disabled={busy}` (`Studio.tsx:678`) and `send()`
   early-returns while `busy` (`:248`), so after the cap the chat is disabled
   **forever**, with a fallback "working…" spinner and only the destructive
   **Stop** button (`:520`) to recover.

`running: true` is trustworthy: `stateOf` returns `c.running`
(`chatSession.ts:185`), set `true` when a turn starts and reset in a `finally`
that runs even on stream-drop / IteratorClose (`chatSession.ts:131,171-173`). So
"Resuming…" means a **real agent turn is genuinely in flight**, not a stale
flag. The desktop keeps the forked core alive when the window is closed to the
tray (`docs/desktop.md`), so that in-flight turn — and the lock — survives
reopen/reload.

### Goal

On resume of a running turn, **show live-ish progress** and **never leave the
chat permanently locked**.

## Approach (chosen: A — transcript-poll, light)

The durable transcript (`GET /api/inspect/session`) reads the on-disk ACP
session log, which claude/codex write **incrementally** during a turn. Polling
it surfaces newly-completed messages/tools as the turn works (chunky, ~poll-
interval lag; not token-by-token).

Rejected for now: **B — true live re-attach** (per-chat event ring-buffer +
subscriber set on `LiveChat`, refactor `sendMessage` from single-consumer to a
broadcast sink, add `GET /api/chat/:id/attach` SSE). Real token-level streaming
and fixes multi-tab attach, but refactors the riskiest core code (the
background-completion guarantee "R1") and needs far more testing. Deferred to a
follow-up if chunky progress proves insufficient.

## Design

All changes are in the console. Both resume entry points already funnel through
`pollWhileRunning` — the mount-resume path (`Studio.tsx:136`) and the
`send()` reconcile path on "already running" / "connection lost"
(`Studio.tsx:267`) — so a single change to `pollWhileRunning` fixes both.

### 1. Transcript-only loader (`studioResume.ts`)

Extract a transcript-only read reused by both `loadStudioSession` and the poll
tick, so the tick doesn't fire a redundant `/state` round-trip (it already
fetches `/state` itself):

```ts
export async function loadStudioTranscript(apiBase: string, name: string): Promise<StudioMsg[]> {
  const stored = getStudioChat(name);
  if (!stored) return [];
  try {
    const view = await inspectSessionRoute.call(makeClient(apiBase), {
      query: { id: stored.sessionId, agent: stored.agent as "claude" | "codex" },
    });
    return transcriptToMsgs(view.turns);
  } catch { return []; }
}
```

`loadStudioSession` is refactored to call `loadStudioTranscript` for its `msgs`
(behavior unchanged: a 404 / read failure → `[]`, not an error).

### 2. `pollWhileRunning` — progress + recovery (`Studio.tsx`)

Rewrite so that while the turn is still running each tick refreshes the
transcript, and the give-up cap is removed:

```js
const POLL_MS = 1500;
const POLL_SLOW_MS = 4000;          // back off after the ramp window
const RAMP_TICKS = Math.round((2 * 60_000) / POLL_MS); // fast for ~2 min, then slow
function pollWhileRunning(id: string) {
  if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null; }
  let ticks = 0;
  const tick = async () => {
    try {
      const st = await fetch(`${apiBase}/api/chat/${encodeURIComponent(id)}/state`)
        .then((r) => r.ok ? r.json() : { alive: false });
      if (!st.alive || !st.running) {                       // turn finished — final reconcile
        setBusy(false); setWorking("");
        const r = await loadStudioSession(apiBase, name);
        setMsgs(r.msgs);
        await refresh();
        return;
      }
      // still running — show progress. Label reads as live once reconnected.
      setWorking("working…");
      const msgs = await loadStudioTranscript(apiBase, name);
      // Only replace when the transcript is caught up, so the send()-path
      // optimistic user message isn't clobbered before it lands on disk.
      // Transcripts only grow during a turn, so this never regresses the log.
      setMsgs((cur) => (msgs.length >= cur.length ? msgs : cur));
    } catch { /* transient — keep polling, keep last log */ }
    ticks++;
    pollRef.current = setTimeout(tick, ticks >= RAMP_TICKS ? POLL_SLOW_MS : POLL_MS);
  };
  pollRef.current = setTimeout(tick, POLL_MS);
}
```

Key changes vs. today:

- **Transcript refresh** in the still-running branch → the log grows as the
  agent works (fixes the frozen placeholder).
- **No give-up cap.** The poll continues (with mild backoff) while the panel is
  mounted; the unmount cleanup already clears `pollRef` (`Studio.tsx:140`). A
  running turn is legitimately running — the `busy` lock stays correct, but
  progress is now visible and **Stop** (`:520`) remains the guaranteed recovery.
  This removes the dead-but-`busy` state by construction.
- **Label progression** `resuming…` → `working…`: the mount path still sets
  `resuming…` before the first tick; the first still-running tick switches to
  `working…`.

### 3. No other UI changes

`busy`-gated composer and the Stop button are unchanged. The lock while a turn
runs is correct; the fix is that resume now shows movement and always recovers.

## Data flow

```
mount / send-reconcile
      │
      ▼
pollWhileRunning(id) ── tick (1.5s→4s) ──▶ GET /api/chat/:id/state
      ▲                                          │
      │                          running:true ───┤─── running:false / !alive
      │                                          │            │
      │              GET /api/inspect/session    │      setBusy(false)
      │              → setMsgs (if caught up)     │      loadStudioSession + refresh preview
      └──────────────── schedule next tick ◀──────┘            (done)
```

## Error handling

- **`/state` fetch throws** → caught, keep polling, keep last log (existing).
- **Transcript read throws** → `loadStudioTranscript` returns `[]`; the
  `msgs.length >= cur.length` guard means `[]` never overwrites a non-empty log.
- **Unmount mid-poll** → cleanup clears `pollRef` (existing).
- **Genuinely wedged turn** (agent `prompt()` never resolves) → poll continues
  showing the last transcript; **Stop** ends it. A server-side watchdog for
  wedged turns is out of scope (future).

## Testing (`Studio.resume.test.tsx`, fake timers)

1. **Progress while running** — `/state` returns `running:true`; the
   `/inspect/session` mock returns one more turn on its 2nd call; after advancing
   a tick, the new message renders.
2. **Optimistic message survives** — send-reconcile path: after the optimistic
   user message is appended, a tick whose transcript hasn't caught up
   (`msgs.length < cur.length`) does **not** drop the user message.
3. **Completion clears** — `/state` flips to `running:false`; `busy` clears, the
   composer re-enables, and the final transcript renders.
4. **No permanent lock** — after many ticks still running, the composer stays in
   the correct (running) locked state with a live spinner, and **Stop** recovers
   it (asserts `DELETE /api/chat/:id` + "session stopped", extending the existing
   Stop test).

Existing resume tests (restore history on mount; resuming spinner + Stop kills;
reconcile-not-fail on transport drop) must continue to pass.

## Files touched

- `packages/console/src/panels/Play/studioResume.ts` — add
  `loadStudioTranscript`; `loadStudioSession` reuses it.
- `packages/console/src/panels/Play/Studio.tsx` — rewrite `pollWhileRunning`
  (transcript refresh, backoff, drop cap, label).
- `packages/console/src/panels/Play/__tests__/Studio.resume.test.tsx` — new
  cases above.

## Out of scope

- Token-by-token streaming / server attach endpoint (Approach B).
- Server-side watchdog for wedged turns.
- Multi-tab live attach.
