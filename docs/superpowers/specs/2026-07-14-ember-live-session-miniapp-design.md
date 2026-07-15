# EMBER — built-in live-session miniapp

Date: 2026-07-14
Status: Approved design, pre-implementation
Branch: `feat/ember-miniapp`

## Summary

Turn the `mockups/ember-session-game.html` prototype into a **built-in miniapp**
that ships with the app and surfaces as a card in the **Arcade** tab. EMBER is a
playful, gamified skin over the context-hygiene signal the app already computes:
a flame that grows and smokes as the current live session's context window fills
toward its cap, scoring the user for "banking" (compacting) while the window is
still lean.

EMBER is the *playful* face of the same signal the Watch tab's `HygieneNudge`
renders *clinically*. Both read one server-computed stream; neither reinvents the
bloat math.

## Goals

- A built-in miniapp, served as a constant (like the Protocol Inspector), that
  appears as a normal card in the Arcade grid — no new tab, no new nav axis.
- Drive the gauge / mood / nudges from **real** current-session data via the
  existing context-hygiene stream (`/api/watch/hygiene`), reusing its computed
  `{ verdict, score, cap, curveTail }` — zero new bloat math in the miniapp.
- Keep the sealed-iframe security model intact: EMBER can *visualize* the live
  session but cannot mutate it.
- Graceful idle behavior when no live session exists.

## Non-goals (this spec)

- **Real BANK → `/compact`.** A sealed miniapp cannot mutate the session by
  design (`ui/update-model-context` / `ui/message` are `handleUnsupportedAction`
  in the console host). Making BANK actually compact the live session is a
  deliberate, consent-gated **phase 2** with its own spec, because a sealed game
  reaching into your live session is a real trust escalation.
- A dedicated top-level tab for EMBER. It rides the existing Arcade surface.
- Changing how user-authored miniapps are created or stored.

## Architecture

### 1. The served constant — `packages/play/src/ember.ts`

Mirror `packages/play/src/inspector.ts`: export `EMBER_META` + `EMBER_HTML`.

- `EMBER_META`: `{ name: "__ember", title: "Ember", genre: <existing enum
  member>, createdFrom: { kind: "blank", title: "Ember" }, engineVersion: "1",
  needs: ["context-hygiene"] }`.
  - `genre` must be one of the existing `PlayMetaSchema` enum values
    (`replay | skill-run | project-fun | session-heatmap`). Pick
    `session-heatmap` (closest: a live read of session state). If none fits well,
    revisit the enum in the plan — but do **not** expand it casually.
- `EMBER_HTML`: the mockup adapted to (a) read pushed `context-hygiene` events
  instead of the internal `requestAnimationFrame` simulation when live data is
  available, and (b) keep the simulation as an idle/demo fallback.

Unlike the Inspector (a hidden dev harness reachable only via a dev route), EMBER
is **listed** so it shows as an Arcade card.

### 2. New capability — `context-hygiene`

The honest model: EMBER wants the *computed* hygiene curve, which is semantically
distinct from raw `live-session-events`. Add a new capability threaded through the
shared surfaces:

- `packages/model/src/types.ts` — add `"context-hygiene"` to the appropriate
  member of the `GameCapability = ToolCapability | ActionCapability` union. It is
  a data-subscription tool (like `live-session-events`), so it belongs in
  `ToolCapability`.
- `packages/model/src/capabilities.ts` — add the capability↔MCP-host-tool mapping
  (`CAP_TOOL` / `TOOL_CAP`). The existing compile-time guard (keyed by
  `GameCapability`) forces this — omitting it fails typecheck. **Not** in
  `AUTO_CAPS` (it reaches the live session → consent-gated).
- `packages/console/src/api/routes.ts` — add `"context-hygiene"` to
  `PlayNeedsSchema`.
- `packages/console/src/panels/Play/mcpHostTools.ts` — declare the host tool
  (description + empty args schema, like `live-session-events`) and its broker.
- `packages/console/src/panels/Play/mcpUiHost.ts` — broker the capability: resolve
  "most-recent session = live" exactly as `subscribeSessions` does, open the
  hygiene stream, and push each event as a notification into the sealed iframe.
- `packages/console/src/panels/Play/consent.ts` — add
  `CAP_LABEL["context-hygiene"]` (e.g. "read your live session's context-health
  signal") and include it in `CONSENT_CAPS`.

> Drift note: `AUTO_CAPS` is defined twice (`packages/model/src/capabilities.ts`
> and `packages/console/src/panels/Play/consent.ts`). `context-hygiene` is
> non-auto, so it is simply absent from both — no change needed there, but the
> plan should confirm both remain consistent.

### 3. Broker wiring — the hygiene stream into the sealed iframe

New host tool, call it `getContextHygiene`, in `mcpHostTools.ts`:

```
export function subscribeHygiene(apiBase, onEvent):
  Promise<{ status: "subscribed"; handle } | { status: "idle" }>
```

- Reuses `fetchSessions(apiBase)` to find the most-recent session `file`
  (identical resolution to `subscribeSessions`).
- No live session → `{ status: "idle" }` so EMBER shows its demo fallback.
- Otherwise `openHygieneStream(apiBase, file, onEvent)` (from
  `packages/console/src/panels/Watch/hygieneStream.ts`) and forward `hygiene` /
  `nudge` events over the capability notification channel.

The broker in `mcpUiHost.ts` owns one open stream at a time (mirror the existing
`liveOpen` guard for `live-session-events`), closes it on generation bump.

### 4. Listing injection — `packages/play/src/miniapps.ts`

Inject the built-in EMBER entry into `listMiniapps()` (or at the
`/api/play/miniapps` route layer, matching wherever the Inspector-style constants
are surfaced) so it appears as a card. Resolve `name === "__ember"` to
`EMBER_HTML` / `EMBER_META` when the card is opened (`/api/play/miniapp`), the way
`/api/play/inspector` serves the Inspector constant. Confirm during the plan which
layer is cleanest (registry list fn vs route composition).

## Data flow

```
live coding session
  → server context-hygiene compute (existing)
  → GET /api/watch/hygiene?file=<most-recent>   (existing SSE)
  → mcpHostTools.subscribeHygiene / mcpUiHost broker  (NEW)
  → postMessage notification into sealed iframe
  → EMBER_HTML maps { score, cap, curveTail, verdict } onto:
       gauge fill   ← score / cap
       mood text    ← verdict + score band
       nudges       ← verdict transitions / nudge advice
```

## BANK semantics (phase 1 — advisory)

- In the sweet spot, BANK fires the "clean cut" combo + a toast:
  "🟢 clean cut — run `/compact` now." Optionally copy `/compact` to the clipboard
  if a zero-permission affordance exists in the sealed context.
- BANK never mutates the session. Score/streak reflect real banking *decisions*,
  persisted in the miniapp's storage shim (`localStorage`) as `best`.

## Idle / demo fallback

- Broker returns `idle` (no live session) → EMBER runs the existing self-contained
  simulation with a small "DEMO" badge so the Arcade card and thumbnail are never
  a dead gauge.
- First real `hygiene` event switches from demo to live and drops the badge.

## Testing

- `packages/play`: EMBER is listed by `listMiniapps` (or the route) and the served
  constant resolves by name; `EMBER_META.needs` includes `context-hygiene`.
- `packages/model`: typecheck guard proves the cap↔tool bijection covers
  `context-hygiene`; unit assert it is absent from `AUTO_CAPS`.
- `packages/console`: broker opens the hygiene stream for a `context-hygiene`
  miniapp and forwards a synthetic `hygiene` event into the Runner; consent copy
  exists for the cap.
- jsdom render: the EMBER document, given a pushed `hygiene` event, updates its
  gauge fill (behavioral, not appearance).
- Real-browser verify per the project UI rule (jsdom never asserts appearance):
  open EMBER in the Arcade against a live session, confirm the flame tracks the
  real curve and the idle demo badge behaves.

## Files touched

New:
- `packages/play/src/ember.ts` (served constant + HTML)
- spec: this file

Modified:
- `packages/model/src/types.ts` (`GameCapability`)
- `packages/model/src/capabilities.ts` (cap↔tool map)
- `packages/play/src/index.ts` (export `EMBER_HTML` / `EMBER_META`)
- `packages/play/src/miniapps.ts` (listing injection) — or the route layer
- `packages/console/src/api/routes.ts` (`PlayNeedsSchema`)
- `packages/console/src/panels/Play/mcpHostTools.ts` (host tool + `subscribeHygiene`)
- `packages/console/src/panels/Play/mcpUiHost.ts` (broker branch)
- `packages/console/src/panels/Play/consent.ts` (`CAP_LABEL` + `CONSENT_CAPS`)

## Phasing

1. **This spec:** built-in EMBER in Arcade, live via `context-hygiene`, advisory
   BANK, demo fallback.
2. **Follow-up spec:** consent-gated real BANK → `/compact` on the live session
   (new host action, explicit trust escalation).
