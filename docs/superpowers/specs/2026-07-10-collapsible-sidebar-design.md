# Resizable layout: collapsible sidebar, draggable pane splits, full-width Studio

**Date:** 2026-07-10
**Status:** Approved design → implementation
**Scope:** `packages/console` only (console shell + panels). No server changes.

## Problem

The console shell is a two-column CSS grid with a **fixed 244px** left sidebar
(`.console { grid-template-columns: 244px 1fr }`) that is always present, and a
main panel capped at `max-width: 1100px`. Inside several panels the working area
is a **fixed-ratio two-pane grid** the user cannot re-proportion. Consequences:

1. No way to reclaim the 244px rail to give the main panel more room.
2. The 1100px cap applies to *every* panel, so the Studio's two-pane grid
   (`.play-grid-2`) stops widening at 1100px — zooming out / a wide monitor buys
   it no space.
3. Side-by-side panes (preview vs chat, master vs detail, editor vs side panel,
   chart vs aside) are frozen at their designed ratio.

## Goals

- **Shrink or hide** the left sidebar via one drag-driven mechanism covering
  three states: full → icon rail → hidden.
- **Resize every genuine two-pane "window"** in the console with a draggable
  divider; the neighbor pane reflows dynamically.
- Make the **Studio (whole Play page)** extend to fill available width.
- **Persist** every resizable state across reloads.
- Rename the Build-phase **"Play"** nav item to **"Studio"**.
- One reusable primitive powers all of the above; contained to `packages/console`.

## Non-goals

- No free-floating/movable windows — only fixed dividers between existing panes.
- No lifting the width cap on non-Studio panels — prose/tables keep their ~1100px
  measure; their internal splits resize *within* that cap.
- No route change for Play (see Rename); no server/API changes.

---

## Design

### A. Shared resize primitive

One low-level hook, `packages/console/src/shell/useDragResize.ts`, owns all the
fiddly drag mechanics so nothing is duplicated across five call sites:

```ts
useDragResize(opts: {
  value: number;                 // current size (px)
  min: number; max: number;
  onChange: (next: number) => void;
  snap?: (raw: number) => number;   // optional (sidebar rail snap)
  invert?: boolean;                 // handle on the pane's right edge (end-side)
}): {
  handleProps: {…};              // role="separator", aria-*, tabIndex, pointer/key handlers
  dragging: boolean;
}
```

- **Delta-based** drag: on `pointerdown`, capture `startClientX` + `startValue`;
  on move, `raw = startValue ± (clientX − startClientX)` (± via `invert`); apply
  optional `snap`, clamp to `[min, max]`, `onChange`. Delta mode works uniformly
  for the sidebar (absolute-feeling) and internal splits (relative).
- **Keyboard a11y:** handle is `role="separator"`, `aria-orientation="vertical"`,
  `aria-valuenow/min/max`, `tabIndex=0`. `←/→` nudge ±16px, `Home`→min, `End`→max.
- All arithmetic is testable without a DOM; the only DOM read is `clientX`.

### B. Sidebar (`shell/sidebar.ts` + `useSidebar`)

Pure logic + a hook that layers sidebar-specific behavior on `useDragResize`.

Replace the fixed grid track with a variable:

```css
.console { grid-template-columns: var(--rail-w) 1fr; }
@property --rail-w { syntax: "<length>"; inherits: true; initial-value: 244px; }
.console { transition: grid-template-columns .18s cubic-bezier(.2,.7,.2,1); }
.console.is-dragging { transition: none; }
```

`Shell` sets `--rail-w` inline from state — drag, snap, hide all reduce to
setting one number; the sticky nav and main follow automatically.

Constants:

| Name | Value | Meaning |
|------|-------|---------|
| `RAIL_W` | 56 | Icon-rail width |
| `FULL_MIN` | 190 | Narrowest labelled width |
| `FULL_MAX` | 420 | Widest sidebar |
| `SNAP_THRESHOLD` | 130 | Drag below ⇒ snap to rail |
| `DEFAULT_WIDTH` | 244 | First-run width |

Pure functions: `resolveWidth(raw)` (`<130`→`RAIL_W`; else clamp to
`[FULL_MIN,FULL_MAX]`) passed as the `snap` to `useDragResize`; `isRail(w)=w<=RAIL_W`;
`effectiveWidth({width,collapsed})` (`collapsed?0:width`); tolerant
`loadRail()/saveRail()` round-tripping `{width,collapsed}` to
`localStorage["agentgem.console.rail"]`.

`useSidebar` exposes `{ width, collapsed, isRail, dragProps, toggleCollapsed }`,
persists on change, and registers a global **`Cmd/Ctrl+B`** listener →
`toggleCollapsed()`.

**Full-hide + re-open:** a collapse toggle in the nav header and `Cmd/Ctrl+B` set
`collapsed`; `--rail-w:0`, `.console.is-hidden`, and a small floating `☰` re-open
button appears top-left.

**Rail-mode reductions (`.console.is-rail`, pure CSS):** brand → mark only;
`.console-nav-item` labels hidden, icon centered, React sets `title={p.title}` for
tooltips; phase pills show their initial via `data-short={p.label[0]}` +
`::before{content:attr(data-short)}`; `.console-group-label`, `WarmingPill` text,
`IdentityChip` text hidden; **`ActiveGemSwitcher` hidden** (widen to switch gems).

### C. Internal pane splits (`shell/useSplit.ts` + `.split-handle`)

`useSplit(id, { initial, min, max, side })` wraps `useDragResize` for one panel,
persisting the resizable pane's px size to `localStorage["agentgem.console.split."+id]`.
Returns `{ containerProps, handle }`:

- `containerProps`: `ref`, `style={{ "--split": px+"px" }}`, adds `is-dragging`.
- `handle`: `<span className="split-handle" data-side={side} {...handleProps} />`,
  absolutely positioned on the seam inside the (now `position:relative`) container
  — `left:var(--split)` for `side:"start"`, `right:var(--split)` for `side:"end"`.

Each panel keeps its existing JSX/grid but (1) makes the resizable column
`var(--split)`, (2) drops in `{split.handle}`, (3) sets `position:relative`.
The default `--split` falls back to the panel's current designed size, so
first paint is unchanged until the user drags.

| Panel | File | Grid becomes | side | initial / min / max | id |
|-------|------|--------------|------|---------------------|-----|
| Studio preview\|chat | `panels/Play/Studio.tsx` (`.play-grid-2`) | `var(--split) minmax(300px,1fr)` | start | 60% / 360 / — (cap = container−320) | `studio` |
| Materialize master\|detail | `panels/Materialize/*` (`.targets-result`) | `var(--split) 1fr` | start | 240 / 190 / 460 | `materialize` |
| Rubric editor\|panel | `panels/RubricLibrary/index.tsx` (`.rub-editor`) | `minmax(0,1fr) var(--split)` | end | 240 / 200 / 420 | `rubric` |
| Hygiene chart\|aside | `.ct` (Received + Observe/ContextTimeline) | `minmax(0,1fr) var(--split)` | end | 288 / 240 / 460 | `hygiene` |

Studio's `max` is computed from container width (keep chat ≥ ~320px) rather than a
constant, since Studio is full-width. `.ct` keeps its `@media (max-width:880px)`
collapse to one column; in that state the handle is hidden and `--split` ignored.

### D. Studio full width

Add optional `fullWidth?: boolean` to `ConsolePage` (`contract.ts`). `Shell` adds
`.console-main--wide` (`max-width:none`) when `active.fullWidth`. Set it on the
Play/Studio page so `.play-grid-2` fills space freed by collapsing the rail and by
zooming out. Play's height budgeting already re-runs on `resize`/`ResizeObserver`;
this unblocks the width axis. Other panels retain the 1100px cap.

### E. Rename Play → Studio

In `panels/Play/index.tsx`, `playPage.title: "Play"` → `"Studio"`. **Keep**
`id:"play"`, `route:"#/play"`, and icon 🎮 unchanged — the marketplace
"Make your own" deep-link (`#/play?new=1&…`) and `LEGACY_ROUTES`/`normalizeHash`
all key on `#/play`; renaming the route would break shared links for zero user
benefit. Only the nav label changes. The internal `view.kind==="studio"` and the
"Studio" sub-view are already named this; the container page now matches.

---

## Files touched

| File | Change |
|------|--------|
| `shell/useDragResize.ts` | **New.** Shared pointer/keyboard/aria drag primitive. |
| `shell/sidebar.ts` | **New.** Sidebar pure logic + `useSidebar` (uses `useDragResize`). |
| `shell/useSplit.ts` | **New.** Per-panel split state + `{containerProps,handle}` (uses `useDragResize`). |
| `shell/Shell.tsx` | `useSidebar`; `--rail-w` + `is-rail`/`is-hidden`/`is-dragging` classes; drag handle, collapse toggle, floating re-open; `data-short`/`title` on nav; `console-main--wide` when `active.fullWidth`. |
| `shell/theme.css` | Variable grid track, `@property`, transitions, `.console-rail-handle`, `.console.is-rail` reductions, `.console.is-hidden`, `.split-handle`, `.console-main--wide`; make the four split containers `position:relative` + `var(--split)` columns. |
| `contract.ts` | Add optional `fullWidth?: boolean`. |
| `panels/Play/index.tsx` | `title:"Studio"`, `fullWidth:true` on `playPage`. |
| `panels/Play/Studio.tsx` | Wire `useSplit("studio")` into `.play-grid-2`. |
| `panels/Materialize/*` | Wire `useSplit("materialize")` into `.targets-result`. |
| `panels/RubricLibrary/index.tsx` | Wire `useSplit("rubric")` into `.rub-editor`. |
| `panels/Received/*` + `panels/Observe/ContextTimeline.tsx` | Wire `useSplit("hygiene")` into `.ct`. |
| `shell/sidebar.test.ts`, `shell/useSplit.test.ts` | **New.** Unit tests for pure logic. |
| `shell/Shell.test.tsx` | Extend for sidebar state + `fullWidth` + rename. |

## Testing

**Unit (pure, no DOM):**
- `resolveWidth` snap/clamp bands; `isRail`; `effectiveWidth(collapsed)→0`.
- `useSplit`/`useDragResize` clamp + `snap` composition; `loadRail`/split persist
  round-trip; malformed JSON / storage throw → defaults (no crash).

**Component (`Shell.test.tsx`, jsdom):**
- `--rail-w` reflects state; `is-rail` at rail width; `Cmd/Ctrl+B` → `is-hidden`
  + `--rail-w:0px` + re-open button present.
- `fullWidth` page → `<main class="… console-main--wide">`; normal page not.
- Nav renders the label **"Studio"** for the Play page (rename guard).

Run locally — console tests are **not** in CI:
`pnpm -C packages/console exec vitest`, then typecheck and `pnpm build` (a
value-import footgun in console breaks only the browser bundle).

## Risks / tradeoffs

- **Drag is the heaviest behavior** (pointer capture, snapping, keyboard a11y) —
  isolated once in `useDragResize`, reused five times, math in tested pure fns.
- **Rail mode hides the gem switcher** — deliberate; widen to switch.
- **Five persistence keys** (`rail` + 4 `split.<id>`) — tolerant parse; a bad/old
  value falls back to the panel default, never a crash or a broken layout.
- **`@property --rail-w`** unsupported ⇒ width still updates, just no tween.
- **Grid-template transition** jank is bounded to the 180ms sidebar toggle (off
  during drag via `is-dragging`); splits don't animate.
- **Touching four panels** widens the blast radius; mitigated by the non-invasive
  wiring (existing JSX kept; add a var + one handle element + `position:relative`)
  and a default `--split` that leaves first paint identical until a drag.
