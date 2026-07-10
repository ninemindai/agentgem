# Collapsible / resizable sidebar + full-width Play Studio

**Date:** 2026-07-10
**Status:** Approved design → implementation
**Scope:** `packages/console` (console shell + Play panel). No server changes.

## Problem

The console shell is a two-column CSS grid with a **fixed 244px** left sidebar
(`.console { grid-template-columns: 244px 1fr }`) that is always present, and a
main panel capped at `max-width: 1100px`. Two consequences:

1. There is no way to reclaim the 244px rail to give the main panel more room.
2. The 1100px cap applies to *every* panel, so the Play Studio's two-pane grid
   (`.play-grid-2`) stops widening at 1100px — zooming out or using a wide
   monitor buys it no extra space.

## Goals

- Let the user **shrink or hide** the left sidebar to give the main panel more
  width, via a single drag-driven mechanism that covers three states:
  full → icon rail → hidden.
- Make the **Play Studio (the whole Play page)** extend to fill available width
  so it grows as the window widens / zooms out, instead of being capped.
- Persist the user's chosen sidebar state across reloads.
- Keep the change contained to `packages/console`; no structural markup rewrite.

## Non-goals

- No per-pixel resize of the *main* panel independently (only the sidebar).
- No lifting the width cap on non-Play panels — prose and tables keep their
  readable ~1100px measure.
- No server / API / registry-wire changes beyond one optional page field.

---

## Design

### 1. One CSS variable drives the grid

Replace the fixed track with a variable, defaulting to today's width:

```css
.console { grid-template-columns: var(--rail-w) 1fr; }
```

`Shell` sets `--rail-w` inline on the `.console` element from state. Every
sidebar behavior — drag, snap-to-rail, full-hide — reduces to *setting one
number*. The sticky nav (`position: sticky; height: 100vh`) and the main panel
follow automatically; no markup restructure.

To allow a smooth animation on toggle (but not during drag), register the
custom property so it is animatable:

```css
@property --rail-w { syntax: "<length>"; inherits: true; initial-value: 244px; }
.console { transition: grid-template-columns .18s cubic-bezier(.2,.7,.2,1); }
.console.is-dragging { transition: none; }   /* live-follow the pointer */
```

### 2. Sidebar state — pure logic in `sidebar.ts`

A new `packages/console/src/shell/sidebar.ts` holds the state machine as **pure
functions** (no DOM), so it is unit-testable — important because jsdom has no
layout and the console test suite is not in CI (must be run locally).

Constants:

| Name             | Value | Meaning                                        |
|------------------|-------|------------------------------------------------|
| `RAIL_W`         | 56    | Icon-rail width (px)                            |
| `FULL_MIN`       | 190   | Narrowest "full" (labelled) width              |
| `FULL_MAX`       | 420   | Widest sidebar                                 |
| `SNAP_THRESHOLD` | 130   | Drag below this ⇒ snap to rail                 |
| `DEFAULT_WIDTH`  | 244   | Initial / first-run width (today's value)      |

State shape (persisted):

```ts
type RailState = { width: number; collapsed: boolean };
```

Pure functions:

```ts
// Snap + clamp a raw dragged width into a resolved sidebar width.
// raw < SNAP_THRESHOLD  → rail mode (RAIL_W)
// otherwise             → full mode, clamped to [FULL_MIN, FULL_MAX]
resolveWidth(raw: number): number

// Is this resolved width the icon rail?
isRail(width: number): boolean            // width <= RAIL_W

// Effective grid width given collapse.
effectiveWidth(s: RailState): number      // collapsed ? 0 : s.width

// localStorage round-trip (tolerant parse; bad data → defaults).
loadRail(): RailState
saveRail(s: RailState): void
```

Persistence key: `localStorage["agentgem.console.rail"]`, matching the existing
`agentgem.console.*` convention (`lastActive`, `lastRoute`). Storage failures
are swallowed (nav still works, just no memory), same as existing code.

### 3. `useSidebar` hook (wiring)

A thin hook in `sidebar.ts` (or `useSidebar.ts`) wires the pure logic to React:

- Initializes from `loadRail()`.
- Exposes `{ width, collapsed, isRail, setWidth, toggleCollapsed, dragProps }`.
- Persists on change (effect).
- Registers the `Cmd/Ctrl+B` global key listener → `toggleCollapsed()`.
- The pointer handler is a thin wire: `pointerdown` captures + sets
  `is-dragging`; `pointermove` computes `clientX` → `resolveWidth` → `setWidth`;
  `pointerup` releases + clears `is-dragging`. All arithmetic lives in
  `resolveWidth`, so the handler itself needs no geometry a test must fake.

### 4. Drag handle (the resize seam)

A single element rendered as a child of `.console`, absolutely positioned on the
seam between the two grid tracks:

```html
<div class="console-rail-handle"
     role="separator" aria-orientation="vertical"
     aria-label="Resize sidebar"
     aria-valuenow={width} aria-valuemin={RAIL_W} aria-valuemax={FULL_MAX}
     tabindex="0" />
```

```css
.console-rail-handle {
  position: fixed; top: 0; bottom: 0; left: var(--rail-w);
  width: 8px; transform: translateX(-4px); cursor: col-resize; z-index: 5;
}
.console.is-hidden .console-rail-handle { display: none; }
```

Keyboard support (handle focused): `←/→` nudge width ±16px (through
`resolveWidth`), `Home` → rail, `End` → `FULL_MAX`.

### 5. Full-hide + re-open

- A collapse **toggle button** lives in the nav header (near the brand); it and
  `Cmd/Ctrl+B` both call `toggleCollapsed()`.
- When `collapsed`, `--rail-w` is `0px`, `.console.is-hidden` is set, and a small
  **floating re-open button** (`☰`) is shown fixed at top-left to restore. The
  hotkey also always restores.

### 6. Rail-mode reductions (`.console.is-rail`)

When the resolved width is the icon rail, the nav shows icons only. CSS-driven
reductions (no conditional React branches beyond adding attributes):

- `.console-brand` → mark only, hide the "AgentGem" text.
- `.console-nav-item` → hide the label text, keep `.console-nav-icon`, center it.
  React always sets `title={p.title}` on the nav button so the label surfaces as
  a native tooltip in rail mode.
- `.console-phase-switch` → phase pills show their **initial** (`O` / `B`). Shell
  adds `data-short={p.label[0]}` to each phase button; CSS in rail mode hides the
  full label and renders `::before { content: attr(data-short) }`.
- `.console-group-label` (Configuration / Sessions / …) → hidden.
- `WarmingPill` text and `IdentityChip` text → hidden (icon/dot only).
- `ActiveGemSwitcher` → **hidden** in rail mode. Switching gems requires widening
  the rail. (Accepted tradeoff: cramming a switcher into 56px is not worth it.)

These are the fiddly bits; all are pure CSS keyed off the `is-rail` class plus a
couple of always-present attributes, so no page/component logic changes.

### 7. Play Studio full width

Add one optional field to `ConsolePage` (`packages/console/src/contract.ts`):

```ts
/** Opt out of the default readable max-width; fill available main width. */
fullWidth?: boolean;
```

`Shell` adds `.console-main--wide` to `<main>` when `active.fullWidth` is set:

```css
.console-main--wide { max-width: none; }
```

Set `fullWidth: true` on `playPage` (`panels/Play/index.tsx`). This lifts the
cap for the entire Play page (Arcade grid, Composer, Studio) so `.play-grid-2`
fills whatever space is freed by collapsing the rail and/or zooming out. Play's
existing height budgeting (`plateMax` via `ResizeObserver` + `resize`) already
reacts to viewport changes; this unblocks the width axis only. All other panels
retain the global `.console-main { max-width: 1100px }`.

---

## Files touched

| File | Change |
|------|--------|
| `packages/console/src/shell/sidebar.ts` | **New.** Pure state logic + `useSidebar` hook. |
| `packages/console/src/shell/Shell.tsx` | Use `useSidebar`; set `--rail-w` + `is-rail`/`is-hidden`/`is-dragging` classes; render drag handle, collapse toggle, floating re-open; `data-short` on phase buttons; `title` on nav items; `console-main--wide` when `active.fullWidth`. |
| `packages/console/src/shell/theme.css` | Variable grid track, `@property --rail-w`, transition, `.console-rail-handle`, `.console.is-rail` reductions, `.console.is-hidden`, `.console-main--wide`, re-open button. |
| `packages/console/src/contract.ts` | Add optional `fullWidth?: boolean` to `ConsolePage`. |
| `packages/console/src/panels/Play/index.tsx` | `fullWidth: true` on `playPage`. |
| `packages/console/src/shell/sidebar.test.ts` | **New.** Unit tests for pure logic. |
| `packages/console/src/shell/Shell.test.tsx` | Extend: class/var reflect state, `Cmd+B` collapse, `fullWidth` → `--wide`. |

## Testing

**Unit (`sidebar.test.ts`, pure — no DOM):**
- `resolveWidth`: below `SNAP_THRESHOLD` → `RAIL_W`; within band → clamped to
  `[FULL_MIN, FULL_MAX]`; at/above `FULL_MAX` → `FULL_MAX`.
- `isRail`, `effectiveWidth(collapsed)` → 0.
- `loadRail`/`saveRail`: round-trip; malformed JSON → defaults; storage throw →
  defaults (no crash).

**Component (`Shell.test.tsx`):**
- `--rail-w` inline var reflects state; `is-rail` toggles when width is rail.
- `Cmd/Ctrl+B` sets `is-hidden` and `--rail-w: 0px`; re-open button appears.
- A `fullWidth` page renders `<main class="… console-main--wide">`; a normal
  page does not.

Run locally (console tests are **not** in CI):
`pnpm -C packages/console exec vitest`. Also run typecheck and `pnpm build`
(a value-import footgun in console breaks only the browser bundle).

## Risks / tradeoffs

- **Drag is the heaviest of the three behaviors** (pointer capture, snapping,
  keyboard a11y). Mitigated by isolating all math in pure, tested functions.
- **Rail mode hides the gem switcher** — deliberate; widen to switch.
- **`@property --rail-w`** for smooth toggle animation: if a target browser
  lacks support, the width still updates (just without the tween). Acceptable.
- **Grid-template-columns transition** can be janky cross-browser; disabled
  during drag via `is-dragging`, and the animated case is only the discrete
  toggle, so any jank is bounded to a 180ms toggle, never live dragging.
