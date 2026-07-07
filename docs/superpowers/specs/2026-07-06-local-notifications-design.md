# Local notifications for the console + Electron app

**Date:** 2026-07-06
**Status:** Approved design, pre-implementation
**Branch:** `feat/local-notifications`

## Goal

Give the local AgentGem console the ability to alert the user — via an in-app
toast and/or an OS notification — when a low-frequency background event happens,
so they don't have to keep the tab focused to know something changed.

Two triggers are in scope; both are already-polled client-side state, so **no
server changes are required**:

1. **Warm pass finished** — the warm daemon's `running` flag transitions
   `true → false` (`GET /api/warm/status`).
2. **New review-queue items** — the Dreaming queue's `queued` count increases
   (`GET /api/dream/status`).

The feature works on both surfaces the console runs on:

- **Plain browser tab** (served over `localhost` by the core server) — browser
  `Notification` API.
- **Electron desktop app** (`desktop/`, loads the same console over
  `http://localhost:<port>`) — native Electron `Notification` via the existing
  `contextBridge`/`ipcMain` plumbing.

### Explicitly out of scope

- **"Agent session finished" notifications.** There is no session-ended event
  today — the Watch feed (`src/watchEvents.ts`) tails the transcript file by
  mtime and only ever emits `phase: "watching"`. Inventing that signal
  (client idle inference / server "ended" event / Stop-hook ping) is deferred.
- **Background delivery when the tab is fully closed** (Web Push). The console
  ships as a single inlined `dist/index.html` with no service worker, so Web
  Push isn't available. Foreground/while-open notifications only. (The Electron
  app, which hides to tray and keeps running, *does* deliver while the window is
  hidden — that's the native `Notification`, not Web Push.)
- Per-category toggles. One master on/off switch only.

## Architecture

One provider, one dispatch function, two output layers.

```
NotificationsProvider (mounted once in Shell.tsx)
  └─ useStatusTriggers()      polls warm + dream status, detects transitions
        └─ dispatch(event)    routes based on window focus:
              ├─ focused  → toast only
              └─ hidden   → toast + osNotify()  (OS banner is the attention-getter)
```

### Components / files

New, under `packages/console/src/notify/`:

- **`osNotify.ts`** — the shared call site. One function, feature-detects the
  Electron bridge, falls back to the browser API:
  ```ts
  export function osNotify(title: string, body: string): void {
    const bridge = (window as any).agentgem;
    if (bridge?.notify) { bridge.notify(title, body); return; }   // Electron: native, no permission
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(title, { body });
    }
    // else: no permission / unsupported → no-op (toast layer still fires)
  }
  ```

- **`useStatusTriggers.ts`** — a hook that polls both status endpoints on an
  interval (default 5s, matching `WarmingPill`), holds the previous snapshot in
  a ref, and invokes a passed `onTrigger(event)` callback when:
  - `prev.running === true && next.running === false` → warm-finished
    (top-level `running`, the same flag `WarmingPill` reads)
  - `next.queued > prev.queued` → `next.queued - prev.queued` new queue items

  The **first successful poll only seeds the baseline** — it never fires on
  mount. Errors are swallowed (status endpoints are best-effort); a failed poll
  leaves the previous snapshot untouched so a transient error can't manufacture
  a false transition.

- **`dispatch.ts`** — pure routing. Given an event and the current visibility
  state, returns/performs: always show a toast; if the document is hidden
  (`document.visibilityState === "hidden"` or `!document.hasFocus()`), also call
  `osNotify`. Kept as a small pure function of `(event, { hidden, notifyEnabled })`
  so it's unit-testable without a DOM.

- **`NotificationsProvider.tsx`** — wires `useStatusTriggers` → `dispatch` →
  the toast context. Reads the user's on/off preference (see below). Mounted
  once in `Shell.tsx`.

New, under `packages/console/src/shell/`:

- **`Toast.tsx`** (+ a tiny `ToastContext`) — the console's first shared toast
  system. A `pushToast(message)` context method; a stacked container rendered
  once in `Shell.tsx`, bottom-right, `role="status" aria-live="polite"`,
  auto-dismiss ~6s, manual close button. This is deliberately minimal — no
  variants/severities beyond a plain informational toast until a second use case
  appears.

Edited:

- **`packages/console/src/shell/Shell.tsx`** — wrap children in
  `ToastContext` + `NotificationsProvider`, render the `<Toast>` container once,
  and add the 🔔 permission/toggle button to the header.

### Permission / the bell toggle

A 🔔 button in the Shell header owns the master on/off preference, persisted in
`localStorage` under `agentgem.notify`.

- **Plain browser:** first enable → `Notification.requestPermission()`. On
  `granted`, store `on` and the bell shows active. On `denied`, the bell shows a
  blocked/muted state and OS notifications stay off (toasts still work). We never
  auto-prompt on load — only on the user's click gesture.
- **Electron:** `window.agentgem.notify` always works and needs no permission,
  so the bell is a pure on/off preference with no prompt.

When the preference is off, `dispatch` still shows in-app toasts? **No** — the
master toggle governs the whole feature: off means neither toasts nor OS
notifications fire. (Rationale: a single mental model — "notifications on/off" —
is clearer than a half-on state. Toasts are cheap to re-enable.)

### Electron side (`desktop/`)

Three small edits, no new dependencies, riding the exact main→renderer push path
that `UPDATE_EVENT` already uses (`main.ts:87`):

- **`desktop/src/ipc.ts`** — add a `NOTIFY` channel constant.
- **`desktop/src/main.ts`** — `ipcMain.on(NOTIFY, (_e, { title, body }) => …)`
  that constructs `new Notification({ title, body })`, `.show()`s it, and on its
  `click` calls `win?.show()` / focuses the window. (Electron `Notification` in
  the main process needs no permission and no HTTPS.)
- **`desktop/src/preload.ts`** — add `notify(title, body)` to the existing
  `contextBridge.exposeInMainWorld("agentgem", { … })`, using
  `ipcRenderer.send(NOTIFY, { title, body })`. Channel literal is inlined per the
  existing sandboxed-preload convention (preload can't import sibling modules;
  keep in sync with `ipc.ts`).

No change to how the window is created, loaded, or the tray behaves.

## Data flow

```
warm daemon / dream pass  (server, unchanged)
        │  GET /api/warm/status, /api/dream/status  (5s poll)
        ▼
useStatusTriggers  ── detects true→false / queued↑ ──▶ onTrigger(event)
        ▼
dispatch(event, { hidden, notifyEnabled })
   ├─ notifyEnabled === false → nothing
   ├─ pushToast(event.message)                     (always, when enabled)
   └─ hidden → osNotify(event.title, event.message)
                   ├─ window.agentgem.notify → Electron main → native banner
                   └─ else Notification.permission==='granted' → new Notification
```

## Error handling

- Poll failures are swallowed; the previous snapshot is preserved so no false
  transition is produced from a gap in data.
- `osNotify` is a no-op when unsupported or unpermitted — the toast layer is the
  guaranteed-visible fallback, so an event is never silently lost while the app
  is focused.
- Electron `ipcRenderer.send` is fire-and-forget; if the main handler throws it's
  logged main-side and the renderer is unaffected.

## Testing

Vitest, in both packages. **Console tests are not in CI** (per repo memory) — run
locally before landing. Desktop tests run under `desktop/src/__tests__/`.

- `useStatusTriggers` transition detection (pure logic extracted): seed →
  no fire on first poll; `running` true→false fires once; `queued` increase fires
  with the correct delta; `queued` decrease / equal does not fire; a poll error
  preserves baseline (no fire).
- `osNotify` routing: bridge present → calls `bridge.notify`, never touches
  `Notification`; no bridge + `granted` → constructs `Notification`; no bridge +
  `default`/`denied` → no-op. Mock `window.agentgem` and global `Notification`.
- `dispatch` focus routing: focused → toast only, `osNotify` not called; hidden →
  toast + `osNotify`; `notifyEnabled=false` → neither.
- Electron `preload`/`ipc`: `notify` sends on the `NOTIFY` channel with
  `{ title, body }`; channel literal matches `ipc.ts`.

## File summary

New:
- `packages/console/src/notify/osNotify.ts`
- `packages/console/src/notify/useStatusTriggers.ts`
- `packages/console/src/notify/dispatch.ts`
- `packages/console/src/notify/NotificationsProvider.tsx`
- `packages/console/src/shell/Toast.tsx` (+ `ToastContext`)
- tests alongside each

Edited:
- `packages/console/src/shell/Shell.tsx` (provider + toast container + bell)
- `desktop/src/ipc.ts` (NOTIFY channel)
- `desktop/src/main.ts` (ipcMain NOTIFY handler)
- `desktop/src/preload.ts` (expose `notify` on the bridge)

No server-side changes.
