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
   composer is `disabled={busy}` (`Studio.tsx:628`) and `send()`
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
interval lag; not token-by-token). Incremental mid-turn writes are proven in
this repo: the shipped Watch Feed (PR #463) renders live in-flight sessions by
tail-following these same logs through the same read path. (Implementation adds
a 2-minute manual check against a real codex turn — see plan Task 3.)

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
const OFFLINE_TICKS = 4;            // consecutive /state failures before the label admits trouble
function pollWhileRunning(id: string) {
  if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null; }
  const gen = ++pollGenRef.current;  // invalidated by unmount cleanup, stop(), or a newer loop
  let ticks = 0;
  let failStreak = 0;
  const tick = async () => {
    try {
      const st = await fetch(`${apiBase}/api/chat/${encodeURIComponent(id)}/state`)
        .then((r) => r.ok ? r.json() : { alive: false });
      if (gen !== pollGenRef.current) return;               // stale loop — no state, no reschedule
      failStreak = 0;
      if (!st.alive || !st.running) {                       // turn finished — final reconcile
        setBusy(false); setWorking("");
        const r = await loadStudioSession(apiBase, name);
        if (gen !== pollGenRef.current) return;
        setMsgs(r.msgs);
        await refresh();
        return;
      }
      // still running — show progress. Label reads as live once reconnected.
      setWorking("working…");
      const msgs = await loadStudioTranscript(apiBase, name);
      if (gen !== pollGenRef.current) return;
      // Replace only when the transcript GREW. The durable log is append-only during
      // a turn, so equal length ⇒ identical content — and adopting a same-length copy
      // would re-fire the scroll-follow effect every tick (yanking a user who scrolled
      // up back to the bottom). Growth-only also means the send()-path optimistic user
      // message and a transient empty read never clobber what's on screen.
      setMsgs((cur) => (msgs.length > cur.length ? msgs : cur));
    } catch {
      // transient — keep polling, keep last log; after a streak, tell the truth
      if (gen !== pollGenRef.current) return;
      if (++failStreak >= OFFLINE_TICKS) setWorking("can't reach the agent — retrying…");
    }
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
  mounted. A running turn is legitimately running — the `busy` lock stays
  correct, but progress is now visible and **Stop** (`:520`) remains the
  guaranteed recovery. This removes the dead-but-`busy` state by construction.
- **Generation guard (`pollGenRef`).** The tick is async, so `clearTimeout` in
  the unmount cleanup cannot stop a tick that is mid-`fetch` — it would resume
  after unmount and reschedule itself, and with the cap gone that orphan loop
  would poll forever (and stack per remount). A `useRef(0)` generation counter
  fixes the class: `pollWhileRunning` captures `gen = ++pollGenRef.current`;
  the tick bails after every `await` and never reschedules when stale; the
  mount-effect cleanup and `stop()` each increment the counter. This also
  guarantees a late tick can't resurrect the spinner after **Stop**.
- **Honest label under failure.** One failed `/state` read is transient — keep
  polling silently. After `OFFLINE_TICKS` consecutive failures the label flips
  to `can't reach the agent — retrying…` (resets on the next success), so an
  unreachable server doesn't masquerade as agent progress. `busy` stays locked
  (the turn may still be running server-side) and Stop stays the recovery.
- **Label progression** `resuming…` → `working…`: the mount path still sets
  `resuming…` before the first tick; the first still-running tick switches to
  `working…`.

### 3. `send()` — a rejected message returns to the composer

The `onFailed` reconcile branch (`Studio.tsx:266-268`) conflates two cases that
must diverge:

- **`connection lost`** — the turn *did* start with the user's message; it will
  land in the transcript. Reconcile-poll as today; the growth guard protects
  the optimistic copy until the transcript catches up.
- **`already running`** — the server **refused** the message
  (`chatSession.ts:127-128`); it will never reach the transcript, so the next
  transcript replace would silently erase it — and `submit()` already cleared
  the composer. Instead: un-append the optimistic user message, restore the
  text via `setInput(message)`, set status
  `agent is still working — message not sent`, then reconcile-poll as today.
  Silent input loss becomes a visible, recoverable state.

### 4. No other UI changes

`busy`-gated composer and the Stop button are unchanged. The lock while a turn
runs is correct; the fix is that resume now shows movement and always recovers.

## Data flow

```
mount / send-reconcile                      unmount cleanup / stop()
      │                                            │
      ▼                                            ▼
pollWhileRunning(id)                        ++pollGenRef  (stale ticks bail:
  gen = ++pollGenRef                         no setState, no reschedule)
      │
      └─ tick (1.5s→4s) ──▶ GET /api/chat/:id/state
      ▲                            │                    │
      │            fetch throws ───┤    running:true ───┤─── running:false / !alive
      │                  │         │                    │            │
      │   failStreak≥4 → label     │   GET /api/inspect/session   setBusy(false)
      │   "can't reach the agent"  │   → setMsgs only if GREW     loadStudioSession
      │                  │         │   (append-only invariant)    + refresh preview
      └──── schedule next tick ◀───┴────────◀───────────┘            (done)
```

## Error handling

- **`/state` fetch throws** → caught, keep polling, keep last log; after
  `OFFLINE_TICKS` consecutive failures the label flips to
  `can't reach the agent — retrying…` (resets on next success).
- **Transcript read throws** → `loadStudioTranscript` returns `[]`; the
  growth-only (`msgs.length > cur.length`) guard means `[]` never overwrites a
  non-empty log.
- **Unmount / Stop mid-poll** → the `pollGenRef` generation guard: a tick that
  resumes after its generation went stale neither touches state nor
  reschedules. (`clearTimeout` alone cannot stop a tick that is mid-`fetch`.)
- **Message rejected ("already running")** → un-append the optimistic copy,
  restore the text to the composer, show a status line (Design §3).
- **Genuinely wedged turn** (agent `prompt()` never resolves) → poll continues
  showing the last transcript; **Stop** ends it. A server-side watchdog for
  wedged turns is out of scope (captured in `TODOS.md`).

## Testing (`Studio.resume.test.tsx`, fake timers)

1. **Progress while running** — `/state` returns `running:true`; the
   `/inspect/session` mock returns one more turn on its 2nd call; after advancing
   a tick, the new message renders.
2. **Optimistic message survives** — send-reconcile path: after the optimistic
   user message is appended, ticks whose transcript hasn't caught up (empty /
   behind) do **not** drop the user message (pins the growth-only guard).
3. **Completion clears (regression-critical)** — `/state` flips to
   `running:false` after some running ticks; `busy` clears, the composer
   re-enables, the spinner disappears, and the final transcript renders. This is
   the direct regression pin for the original never-unlocks defect.
4. **No permanent lock** — after many ticks still running (well past the old
   ~10-min cap), the composer stays in the correct (running) locked state with a
   live spinner, and **Stop** recovers it (asserts `DELETE /api/chat/:id` +
   "session stopped"). After Stop, advancing timers further produces **no**
   additional fetches and no resurrected spinner (generation invalidated).
5. **Unmount stops polling** — unmount the panel mid-poll, advance timers:
   fetch-call count does not grow (no orphan loop).
6. **Transient failure recovers** — `/state` throws on one tick; the poll
   survives, and a later `running:false` tick still completes normally.
7. **Degraded label** — `/state` throws for `OFFLINE_TICKS` consecutive ticks →
   label reads `can't reach the agent — retrying…`.
8. **Rejected message restored** — stream reports "already running": the
   optimistic message leaves the log, the text returns to the composer
   (`getByDisplayValue`), and the status line shows.

Existing resume tests (restore history on mount; resuming spinner + Stop kills;
reconcile-not-fail on transport drop) must continue to pass.

**jsdom blind spot:** the scroll-follow behavior (growth-only replace not
yanking a scrolled-up reader) has no scroll geometry in jsdom — verify manually
in the real app during a long turn.

## Files touched

- `packages/console/src/panels/Play/studioResume.ts` — add
  `loadStudioTranscript`; `loadStudioSession` reuses it.
- `packages/console/src/panels/Play/Studio.tsx` — rewrite `pollWhileRunning`
  (transcript refresh, backoff, drop cap, generation guard, labels); split the
  `onFailed` reconcile branch (Design §3); add `pollGenRef` + increments in the
  mount cleanup and `stop()`.
- `packages/console/src/panels/Play/__tests__/Studio.resume.test.tsx` — new
  cases above.

## Out of scope

- Token-by-token streaming / server attach endpoint (Approach B) — revisit if
  chunky progress proves insufficient.
- Server-side watchdog for wedged turns (captured in `TODOS.md`).
- Multi-tab live attach.
- Conditional transcript fetch (ETag/mtime) — per-tick re-parse cost accepted
  for a local single-user server; revisit only if profiling shows it.
