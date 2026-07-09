# Console identity in the shell

**Date:** 2026-07-08
**Status:** Approved, ready for planning

## Problem

Two symptoms of one root cause.

1. **The web handoff is buried.** `POST /api/auth/web-handoff` mints a one-time
   code and returns a URL that lands the user on `app.agentgem.ai` already signed
   in. It is reachable from exactly one place: an "Open on the web ↗" button in
   Settings → Verify identity, gated on `bound && sessionActive`. Nothing in the
   shell tells the user who they are or offers to open the web app as them.

2. **Publishing a mini-game dead-ends when unbound.** `Play/Studio.tsx`
   `shareToExplore()` saves the game, checks the bind, and on failure sets the
   status string `"Connect your GitHub in Curate to publish publicly."` — a
   message that names a different panel and offers no action.

The root cause: **identity is a shell-level fact rendered ad-hoc per panel.** The
device-flow connect UI is implemented twice already (`Settings/index.tsx`,
`Curate/PublishToExplore.tsx`) and Studio needs a third. Two copies are fine; the
third is the signal to extract.

Nothing changes server-side. The bind routes and the handoff route already do
exactly what is needed.

## Design

### Status and flow have different lifetimes

Each panel today re-fetches bind status and owns its own device-flow state,
tangled together. They separate cleanly:

- **Status** (`bound`, `login`, `avatarUrl`, `sessionActive`) is one fact about
  the machine. If each consumer holds its own copy, connecting in Studio leaves
  the footer chip stale.
- **Flow** (device code, polling, "Copy code & open GitHub") is ephemeral and
  per-panel. Studio's banner and Settings' row must not share a spinner.

So: a context for status, a hook for flow.

```
packages/console/src/identity/
  IdentityProvider.tsx    context { status, refresh } — one bindStatusRoute fetch
  useGitHubBind.ts        flow { connect, copyOpenAndWait, polling, error }
  ConnectGitHub.tsx       presentational: user code + copy/open button + error
  ConnectGitHubModal.tsx  centered modal chrome wrapping ConnectGitHub
  IdentityChip.tsx        footer chip → webHandoffRoute | opens the modal
```

`ConnectGitHub` is presentational and chrome-free, so it composes two ways with
no duplicated logic: Studio renders it as an **inline banner**, the chip renders
it **inside `ConnectGitHubModal`**. One flow hook, two chromes.

`useGitHubBind({ onBound })` owns local flow state and calls the context's
`refresh()` on success, so every consumer converges on one status.

`IdentityProvider` fetches `bindStatusRoute` once on mount and thereafter only
when `refresh()` is called (after a bind completes, or a disconnect). No polling.

The two existing copies diverge in three places. Each is resolved toward the
Settings behavior, which is the better of the two in every case:

1. **Opened URL.** Settings opens `verificationUriComplete ?? verificationUri`
   (the code-prefilled URL — the user lands on "just click Authorize");
   `PublishToExplore` opens the bare `verificationUri`. The hook takes the
   `?? ` form. `PublishToExplore.test.tsx:108` *does* assert the opened URL
   (`expect(openSpy).toHaveBeenCalledWith("https://github.com/login/device", …)`),
   but its stub never sets `verificationUriComplete`, so the coalesce yields the
   bare URL and the assertion still passes.
2. **Rejection copy.** Settings maps slugs through `rejectionMessage()`
   ("Publish or share a Gem first…"); Curate has a one-off string for
   `unknown-producer`. `rejectionMessage` moves into the hook's module and both
   consumers get it. Only `Settings.test.tsx:114` asserts on this copy.
3. **Unconfigured server.** Settings renders "Verification unavailable (not
   configured)"; Curate sets a free-text error. The hook exposes
   `unconfigured: boolean` and each consumer renders its own text, so
   `Settings.test.tsx:91` keeps passing.

### Consumers

| File | Change |
|---|---|
| `shell/Shell.tsx` | wrap tree in `IdentityProvider`; render `<IdentityChip>` in `console-footer` |
| `panels/Settings/index.tsx` | consume the hook; delete its copy of the flow |
| `panels/Curate/PublishToExplore.tsx` | consume the hook; delete its copy of the flow |
| `panels/Play/Studio.tsx` | replace the dead-end string with `<ConnectGitHub>` + resume |

### Chip states

- **bound + `sessionActive`** — avatar + `@login`. Click mints the one-time
  handoff code and opens `app.agentgem.ai` signed in (desktop: `main.ts` routes
  `window.open` to the system browser).
- **bound, session expired** — avatar + `@login`, dimmed. Click opens
  `ConnectGitHubModal` to re-establish the session; a handoff code cannot be
  minted without a live one.
- **unbound** — "Sign in" chip. Click opens `ConnectGitHubModal`.

Signing in is therefore possible from the chip itself; the chip is the primary
identity affordance, not a shortcut into Settings. Settings keeps its own connect
row (it also owns Disconnect, which the chip does not offer).

### The modal

`Setup/index.tsx` already has a modal, but it is panel-local: its `setup-modal`
classes live in `theme.css` and are Setup's to rename. Reusing those class names
from an identity component would couple the chip to Setup's stylesheet.

So `ConnectGitHubModal` owns its own `identity-modal` classes and repeats the
overlay/panel/Escape pattern. No shared `<Modal>` primitive is extracted: that
would be an abstraction with one real consumer, and retrofitting Setup and
`Play/Runner` is scope this change did not ask for. A third dialog is the moment
to extract.

Behavior, matching Setup's modal so the console stays coherent:

- `role="dialog"`, `aria-modal="true"`, labelled "Connect GitHub".
- Escape closes; overlay click closes; panel click does not (`stopPropagation`).
- Focus moves to the copy/open button on open, and returns to the chip on close.
- Closing mid-flow abandons the device code. The next open calls `bindStart`
  again rather than resuming a code that may have expired.

### Studio publish flow

`shareToExplore()` splits at the seam that already exists:

```
shareToExplore()
  save()                              // gate + workspace creation, unchanged
  if (status.bound && status.login)  return publishWorkspace(status.login)
  setPendingPublish(true)             // render <ConnectGitHub> in the banner slot
```

Resume rides the hook's success callback:

```
useGitHubBind({ onBound: (login) => {
  if (pendingPublish) { setPendingPublish(false); void publishWorkspace(login) }
}})
```

Three properties, in order of how much they matter:

**`publishWorkspace(login)` takes `login` as an argument.** `bindComplete`
already returns it. Reading it back off the refreshed context would race the
React render that applies the refresh, so resume could observe a stale `null`.

**`save()` is not re-run on resume.** The workspace and its seal were created
before we discovered the bind was missing. Re-saving re-runs the gate for no
reason and can surface a spurious gate banner immediately after a *successful*
authorization.

**`pendingPublish` resets on cancel and on error.** A latent resume flag that
fires on some later unrelated bind is worse than no resume at all.

## Error handling

- `bindComplete` rejects (`access_denied`, timeout) → `ConnectGitHub` renders the
  reason inline; `pendingPublish` cleared. The game is still saved, so the user
  can click Share again.
- `webHandoffRoute` returns `{authenticated: false}` (session expired between
  chip render and click) → the chip opens `ConnectGitHubModal` rather than
  opening a signed-out tab. The server already cleared the dead session on its
  401, so this is the correct recovery: reconnect, then click again.
- Publish fails after a successful bind → the existing `share failed: …` status,
  unchanged.

## Testing

Console tests are not in CI (see `ci-skips-console-tests`), so
`pnpm -C packages/console test` runs locally and the result is reported.

- **Regression (the extraction):** every existing assertion in
  `Settings.test.tsx` and `PublishToExplore.test.tsx` survives **byte-for-byte**.
  The only permitted edit is wrapping `render(...)` in `<IdentityProvider>`,
  since `useIdentity()` throws without one. If an *assertion* has to change, the
  hook's shape is wrong and the task should stop. These two files are the safety
  net that makes this an extraction rather than a rewrite.
- **Chip:** bound + active renders `@login` and click opens the handoff URL.
  Unbound renders "Sign in"; click opens the modal and calls `bindStart`.
  Resolving `bindComplete` closes the modal and the chip becomes `@login` —
  proving `refresh()` propagates through the context.
- **Modal:** Escape closes it; overlay click closes it; a click inside the panel
  does not. Closing mid-flow and reopening calls `bindStart` a second time.
- **Resume:** stub `bindStatus` unbound → click Share → assert `publishSetupRoute`
  was *not* called and the connect banner is present → resolve `bindComplete`
  with `{bound: true, login: "rfeng"}` → assert `publishSetupRoute` called exactly
  once with `scope: "rfeng"`, and that `save` ran once, not twice.

The `save` ran once assertion is the one that catches a regression in the resume
path.

## Out of scope

- Any server-side change. The bind and handoff routes are sufficient.
- Disconnecting from the chip. Settings keeps sole ownership of Disconnect.
- Extracting a shared `<Modal>` primitive, or retrofitting the existing modals in
  `Setup/index.tsx` and `Play/Runner.tsx` onto one.
- Surfacing identity in the marketplace SPA, or in the desktop title bar.
