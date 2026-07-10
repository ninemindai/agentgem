# Resizable Layout — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the console's left sidebar drag-resizable / snap-to-rail / hideable, make the Studio (Play page) preview↔chat divider draggable and the page full-width, and rename the "Play" nav item to "Studio".

**Architecture:** One low-level `useDragResize` hook owns all pointer/keyboard/aria drag mechanics. `sidebar.ts` layers snap-to-rail + hide on top and derives a display width from a raw drag value; `useSplit` layers per-panel persistence for internal dividers. The console grid track and each split column become CSS variables, so resizing is "set one number" and the layout reflows for free.

**Tech Stack:** React 18 + TypeScript (ESM, `.js` import specifiers), CSS custom properties + `@property`, Vitest + @testing-library/react (jsdom), localStorage.

## Global Constraints

- **Package:** all changes in `packages/console`. No server/API/registry-wire changes beyond adding one optional `ConsolePage` field.
- **ESM imports:** import local modules with explicit `.js` extension (e.g. `./sidebar.js`), matching every existing file.
- **localStorage keys:** namespace `agentgem.console.*` (existing convention). New keys: `agentgem.console.rail`, `agentgem.console.split.<id>`. All reads tolerant — malformed/absent/throwing storage falls back to defaults, never crashes.
- **Route stability:** do NOT change `playPage.route` (`#/play`) or `playPage.id` (`play`). Only the `title` changes. Marketplace deep-links and `LEGACY_ROUTES` key on `#/play`.
- **Tests are local-only (not in CI).** Run `pnpm -C packages/console exec vitest` after each task; before finishing also run typecheck and `pnpm -C packages/console build` (a value-import footgun in console breaks only the browser bundle).
- **jsdom has no `PointerEvent` / `setPointerCapture`.** Test drag *arithmetic* via pure functions and interaction via keyboard (`fireEvent.keyDown`). Guard `setPointerCapture?.()` with optional chaining in code.
- **Sidebar constants (verbatim):** `RAIL_W=56`, `FULL_MIN=190`, `FULL_MAX=420`, `SNAP_THRESHOLD=130`, `DEFAULT_WIDTH=244`.

---

### Task 1: `useDragResize` primitive

**Files:**
- Create: `packages/console/src/shell/useDragResize.ts`
- Test: `packages/console/src/shell/useDragResize.test.tsx`

**Interfaces:**
- Produces:
  - `applyDrag(startValue: number, delta: number, o: { min: number; max: number; invert?: boolean }): number` — pure; clamps `startValue ± delta` to `[min,max]`.
  - `type DragResizeOpts = { value: number; min: number; max: number; onChange: (n: number) => void; onCommit?: (n: number) => void; invert?: boolean; step?: number }`
  - `useDragResize(o: DragResizeOpts): { dragging: boolean; handleProps: Record<string, unknown> }` — `handleProps` spreads onto the divider element (`role="separator"`, `aria-*`, `tabIndex`, pointer + key handlers).

- [ ] **Step 1: Write the failing test**

```tsx
// packages/console/src/shell/useDragResize.test.tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { applyDrag, useDragResize } from "./useDragResize.js";

afterEach(cleanup);

describe("applyDrag (pure)", () => {
  it("adds delta and clamps to [min,max]", () => {
    expect(applyDrag(200, 50, { min: 100, max: 300 })).toBe(250);
    expect(applyDrag(200, 500, { min: 100, max: 300 })).toBe(300);
    expect(applyDrag(200, -500, { min: 100, max: 300 })).toBe(100);
  });
  it("inverts delta for end-side handles", () => {
    expect(applyDrag(200, 50, { min: 100, max: 300, invert: true })).toBe(150);
  });
});

function Harness({ onChange }: { onChange: (n: number) => void }) {
  const { handleProps } = useDragResize({ value: 200, min: 100, max: 300, onChange, step: 16 });
  return <div data-testid="h" {...handleProps} />;
}

describe("useDragResize keyboard", () => {
  it("nudges by step on Arrow keys and jumps on Home/End", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const h = screen.getByTestId("h");
    fireEvent.keyDown(h, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith(216);
    fireEvent.keyDown(h, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith(184);
    fireEvent.keyDown(h, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith(300);
    fireEvent.keyDown(h, { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith(100);
  });
  it("exposes separator a11y props", () => {
    render(<Harness onChange={() => {}} />);
    const h = screen.getByTestId("h");
    expect(h.getAttribute("role")).toBe("separator");
    expect(h.getAttribute("aria-valuenow")).toBe("200");
    expect(h.getAttribute("aria-valuemin")).toBe("100");
    expect(h.getAttribute("aria-valuemax")).toBe("300");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/console exec vitest run src/shell/useDragResize.test.tsx`
Expected: FAIL — cannot resolve `./useDragResize.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/console/src/shell/useDragResize.ts
import { useCallback, useRef, useState } from "react";

/** Pure: shift `startValue` by `delta` (negated for end-side handles) and clamp. */
export function applyDrag(
  startValue: number,
  delta: number,
  o: { min: number; max: number; invert?: boolean },
): number {
  const raw = startValue + (o.invert ? -delta : delta);
  return Math.max(o.min, Math.min(o.max, raw));
}

export type DragResizeOpts = {
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
  /** Fired on pointer-up / key commit — lets a caller resolve a raw value (e.g. snap). */
  onCommit?: (n: number) => void;
  /** Handle sits on the pane's END edge; dragging right shrinks the pane. */
  invert?: boolean;
  /** Keyboard nudge in px (default 16). */
  step?: number;
};

export function useDragResize(o: DragResizeOpts) {
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; value: number } | null>(null);
  const step = o.step ?? 16;

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    start.current = { x: e.clientX, value: o.value };
    setDragging(true);
    (e.target as Element).setPointerCapture?.(e.pointerId); // jsdom: no-op
  }, [o.value]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!start.current) return;
    o.onChange(applyDrag(start.current.value, e.clientX - start.current.x, o));
  }, [o]);

  const end = useCallback(() => {
    if (start.current) o.onCommit?.(o.value);
    start.current = null;
    setDragging(false);
  }, [o]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Keyboard operates directly on `value` (no invert) so Right always = larger.
    const d = e.key === "ArrowRight" ? step
      : e.key === "ArrowLeft" ? -step
      : e.key === "End" ? 1e7
      : e.key === "Home" ? -1e7
      : null;
    if (d == null) return;
    e.preventDefault();
    const next = applyDrag(o.value, d, { min: o.min, max: o.max });
    o.onChange(next);
    o.onCommit?.(next);
  }, [o, step]);

  return {
    dragging,
    handleProps: {
      role: "separator",
      "aria-orientation": "vertical",
      "aria-valuenow": Math.round(o.value),
      "aria-valuemin": o.min,
      "aria-valuemax": o.max,
      tabIndex: 0,
      onPointerDown,
      onPointerMove,
      onPointerUp: end,
      onPointerCancel: end,
      onKeyDown,
    } as Record<string, unknown>,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C packages/console exec vitest run src/shell/useDragResize.test.tsx`
Expected: PASS (5 assertions across 4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/shell/useDragResize.ts packages/console/src/shell/useDragResize.test.tsx
git commit -m "feat(console): add useDragResize drag/keyboard/aria primitive"
```

---

### Task 2: `sidebar.ts` — snap + hide state

**Files:**
- Create: `packages/console/src/shell/sidebar.ts`
- Test: `packages/console/src/shell/sidebar.test.tsx`

**Interfaces:**
- Consumes: `useDragResize`, `applyDrag` from `./useDragResize.js`.
- Produces:
  - Constants `RAIL_W, FULL_MIN, FULL_MAX, SNAP_THRESHOLD, DEFAULT_WIDTH`.
  - `resolveWidth(raw: number): number` — `raw < SNAP_THRESHOLD → RAIL_W`, else `clamp(raw, FULL_MIN, FULL_MAX)`.
  - `isRail(width: number): boolean` — `width <= RAIL_W`.
  - `type RailState = { width: number; collapsed: boolean }`
  - `loadRail(): RailState`, `saveRail(s: RailState): void`.
  - `useSidebar(): { width: number; collapsed: boolean; isRail: boolean; dragging: boolean; handleProps: Record<string, unknown>; toggleCollapsed: () => void }` — `width` is the effective grid width (0 when collapsed); registers a global `Cmd/Ctrl+B` toggle.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/console/src/shell/sidebar.test.tsx
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { resolveWidth, isRail, loadRail, saveRail, RAIL_W, FULL_MIN, FULL_MAX, useSidebar } from "./sidebar.js";

afterEach(() => { cleanup(); localStorage.clear(); });

describe("resolveWidth", () => {
  it("snaps below threshold to the rail width", () => {
    expect(resolveWidth(0)).toBe(RAIL_W);
    expect(resolveWidth(129)).toBe(RAIL_W);
  });
  it("clamps full mode to [FULL_MIN, FULL_MAX]", () => {
    expect(resolveWidth(130)).toBe(FULL_MIN); // dead zone rounds up to min
    expect(resolveWidth(244)).toBe(244);
    expect(resolveWidth(9999)).toBe(FULL_MAX);
  });
});

describe("isRail", () => {
  it("is true only at the rail width", () => {
    expect(isRail(RAIL_W)).toBe(true);
    expect(isRail(FULL_MIN)).toBe(false);
  });
});

describe("loadRail/saveRail", () => {
  it("round-trips and defaults on garbage", () => {
    saveRail({ width: 300, collapsed: true });
    expect(loadRail()).toEqual({ width: 300, collapsed: true });
    localStorage.setItem("agentgem.console.rail", "{not json");
    expect(loadRail().collapsed).toBe(false);
  });
});

function Probe() {
  const s = useSidebar();
  return <div data-testid="p" data-w={s.width} data-collapsed={String(s.collapsed)} {...s.handleProps} />;
}
describe("useSidebar Cmd/Ctrl+B", () => {
  it("toggles collapsed and zeroes width", () => {
    render(<Probe />);
    const p = screen.getByTestId("p");
    expect(p.getAttribute("data-collapsed")).toBe("false");
    act(() => { fireEvent.keyDown(window, { key: "b", metaKey: true }); });
    expect(screen.getByTestId("p").getAttribute("data-collapsed")).toBe("true");
    expect(screen.getByTestId("p").getAttribute("data-w")).toBe("0");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/console exec vitest run src/shell/sidebar.test.tsx`
Expected: FAIL — cannot resolve `./sidebar.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/console/src/shell/sidebar.ts
import { useCallback, useEffect, useRef, useState } from "react";
import { useDragResize } from "./useDragResize.js";

export const RAIL_W = 56;
export const FULL_MIN = 190;
export const FULL_MAX = 420;
export const SNAP_THRESHOLD = 130;
export const DEFAULT_WIDTH = 244;

/** Snap a raw dragged width to the rail or clamp it to the full-mode band. */
export function resolveWidth(raw: number): number {
  if (raw < SNAP_THRESHOLD) return RAIL_W;
  return Math.max(FULL_MIN, Math.min(FULL_MAX, raw));
}

export function isRail(width: number): boolean {
  return width <= RAIL_W;
}

export type RailState = { width: number; collapsed: boolean };
const KEY = "agentgem.console.rail";

export function loadRail(): RailState {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "");
    if (raw && typeof raw === "object") {
      const o = raw as Record<string, unknown>;
      const width = typeof o.width === "number" ? resolveWidth(o.width) : DEFAULT_WIDTH;
      return { width, collapsed: o.collapsed === true };
    }
  } catch { /* absent or malformed → defaults */ }
  return { width: DEFAULT_WIDTH, collapsed: false };
}

export function saveRail(s: RailState): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}

export function useSidebar() {
  const initial = useRef(loadRail());
  // rawWidth is the continuous drag variable; display width is its snap.
  const [rawWidth, setRawWidth] = useState(initial.current.width);
  const [collapsed, setCollapsed] = useState(initial.current.collapsed);
  const width = resolveWidth(rawWidth);

  useEffect(() => { saveRail({ width, collapsed }); }, [width, collapsed]);

  const { dragging, handleProps } = useDragResize({
    value: rawWidth,
    min: RAIL_W,
    max: FULL_MAX,
    onChange: setRawWidth,
    onCommit: (v) => setRawWidth(resolveWidth(v)), // settle handle onto the snapped position
  });

  const toggleCollapsed = useCallback(() => setCollapsed((c) => !c), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "b" || e.key === "B")) {
        e.preventDefault();
        toggleCollapsed();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleCollapsed]);

  return {
    width: collapsed ? 0 : width,
    collapsed,
    isRail: !collapsed && isRail(width),
    dragging,
    handleProps,
    toggleCollapsed,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C packages/console exec vitest run src/shell/sidebar.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/shell/sidebar.ts packages/console/src/shell/sidebar.test.tsx
git commit -m "feat(console): sidebar snap/hide state on useDragResize"
```

---

### Task 3: Wire the sidebar into Shell + CSS

**Files:**
- Modify: `packages/console/src/shell/Shell.tsx`
- Modify: `packages/console/src/shell/theme.css` (`.console` line 65; `.console-brand` ~79; `.console-phase-btn` ~121)
- Test: `packages/console/src/shell/Shell.test.tsx`

**Interfaces:**
- Consumes: `useSidebar` from `./sidebar.js`.
- Produces: the `.console` element carries inline `--rail-w`, classes `is-rail` / `is-hidden` / `is-dragging`; a `.console-rail-handle` separator; a collapse toggle + floating `.console-reopen` button; phase buttons gain `data-short`; nav items gain `title`.

- [ ] **Step 1: Write the failing test** (append to `Shell.test.tsx`)

```tsx
describe("Shell — collapsible sidebar", () => {
  it("sets --rail-w and toggles is-hidden on Cmd+B", () => {
    const { container } = render(<Shell pages={pages} apiBase="" />);
    const console_ = container.querySelector(".console") as HTMLElement;
    expect(console_.style.getPropertyValue("--rail-w")).toBe("244px");
    act(() => { fireEvent.keyDown(window, { key: "b", metaKey: true }); });
    expect(console_.classList.contains("is-hidden")).toBe(true);
    expect(console_.style.getPropertyValue("--rail-w")).toBe("0px");
    // re-open affordance appears when hidden
    expect(screen.getByRole("button", { name: /open sidebar/i })).toBeTruthy();
  });

  it("renders a resize separator with sidebar bounds", () => {
    const { container } = render(<Shell pages={pages} apiBase="" />);
    const sep = container.querySelector(".console-rail-handle") as HTMLElement;
    expect(sep.getAttribute("role")).toBe("separator");
    expect(sep.getAttribute("aria-valuemax")).toBe("420");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/console exec vitest run src/shell/Shell.test.tsx -t "collapsible sidebar"`
Expected: FAIL — no `--rail-w` / `.console-rail-handle`.

- [ ] **Step 3a: Edit `Shell.tsx`** — import and consume the hook.

Add after the existing `IdentityChip` import (line 11):

```tsx
import { useSidebar } from "./sidebar.js";
```

Inside `Shell`, after `const { keys } = useActiveGem();` (line 59) add:

```tsx
  const sidebar = useSidebar();
```

Change the phase-button JSX (the `<button role="radio" …>` in the `.console-phase-switch` map, ~line 156) to add `data-short`:

```tsx
              <button
                key={p.id}
                type="button"
                role="radio"
                data-short={p.label[0]}
                aria-checked={p.id === phase}
                className={"console-phase-btn" + (p.id === phase ? " is-active" : "")}
                {...roving.getTabProps(i)}
                onClick={() => goPhase(p.id)}
              >
                {p.label}
              </button>
```

Change the `item` nav-button (line 129-138) to add a `title`:

```tsx
  const item = (p: ConsolePage) => (
    <button
      key={p.id}
      title={p.title}
      className={"console-nav-item" + (p === active ? " is-active" : "") + (p.requiresGem && !hasGem ? " is-locked" : "")}
      onClick={() => { window.location.hash = p.route; }}
    >
      {p.icon ? <span className="console-nav-icon">{p.icon}</span> : null}
      {p.title}
    </button>
  );
```

Replace the outer `<div className="console">` open tag and add the handle + toggle + re-open. The return's top changes from:

```tsx
      <div className="console">
        <nav className="console-nav">
          <div className="console-brand">
```

to:

```tsx
      <div
        className={"console" + (sidebar.isRail ? " is-rail" : "") + (sidebar.collapsed ? " is-hidden" : "") + (sidebar.dragging ? " is-dragging" : "")}
        style={{ ["--rail-w" as string]: `${sidebar.width}px` }}
      >
        {sidebar.collapsed && (
          <button className="console-reopen" aria-label="Open sidebar" onClick={sidebar.toggleCollapsed}>☰</button>
        )}
        <nav className="console-nav">
          <div className="console-brand">
            <button className="console-collapse" aria-label="Collapse sidebar" onClick={sidebar.toggleCollapsed}>⟨</button>
```

Then find the brand block close. The current brand is:

```tsx
          <div className="console-brand">
            <svg className="console-mark" …>…</svg>
            AgentGem
          </div>
```

The collapse button is inserted as the FIRST child of `.console-brand` (shown above) — keep the existing `<svg>` and `AgentGem` after it.

Finally, add the handle as a child of `.console`, immediately before `</div>` that closes `.console` (currently after `<NotificationsProvider … />` on line 179):

```tsx
        <main className="console-main">{ActivePage ? <ActivePage apiBase={apiBase} /> : null}</main>
        <NotificationsProvider apiBase={apiBase} />
        {!sidebar.collapsed && <div className="console-rail-handle" {...sidebar.handleProps} />}
      </div>
```

- [ ] **Step 3b: Edit `theme.css`** — variable track + handle + rail + hidden.

Replace line 65:

```css
.console { display: grid; grid-template-columns: 244px 1fr; min-height: 100vh; }
```

with:

```css
@property --rail-w { syntax: "<length>"; inherits: true; initial-value: 244px; }
.console {
  display: grid; grid-template-columns: var(--rail-w) 1fr; min-height: 100vh;
  transition: grid-template-columns .18s cubic-bezier(.2,.7,.2,1);
}
.console.is-dragging { transition: none; }

/* Resize seam between rail and main. Fixed so it spans the viewport height. */
.console-rail-handle {
  position: fixed; top: 0; bottom: 0; left: var(--rail-w);
  width: 8px; transform: translateX(-4px); z-index: 6; cursor: col-resize;
  background: transparent;
}
.console-rail-handle:hover, .console-rail-handle:focus-visible {
  background: linear-gradient(90deg, transparent 2px, var(--accent) 3px, var(--accent) 5px, transparent 6px);
  outline: none;
}

/* Collapse (in the brand) and floating re-open button. */
.console-collapse {
  margin-right: 2px; border: 0; background: none; cursor: pointer;
  color: var(--muted); font-size: 15px; line-height: 1; padding: 2px 4px; border-radius: 5px;
}
.console-collapse:hover { color: var(--accent); background: rgba(154,51,36,.06); }
.console-reopen {
  position: fixed; top: 14px; left: 10px; z-index: 7;
  width: 30px; height: 30px; border-radius: 8px; border: 1px solid var(--line);
  background: var(--raised); color: var(--ink-soft); cursor: pointer;
  box-shadow: var(--shadow-sm); font-size: 15px;
}
.console-reopen:hover { color: var(--accent); border-color: var(--accent); }

/* Fully hidden: no rail padding bleed, no handle. */
.console.is-hidden .console-nav { display: none; }

/* ── Icon-rail mode: icons only, labels as tooltips ── */
.console.is-rail .console-nav { padding-left: 8px; padding-right: 8px; align-items: stretch; }
.console.is-rail .console-brand { justify-content: center; }
.console.is-rail .console-brand svg { margin: 0; }
/* hide the wordmark text nodes but keep the mark + collapse button */
.console.is-rail .console-brand { font-size: 0; gap: 0; }
.console.is-rail .console-brand svg { width: 20px; height: 20px; }
.console.is-rail .console-collapse { font-size: 13px; }
.console.is-rail .console-nav-item { justify-content: center; padding-left: 0; padding-right: 0; font-size: 0; gap: 0; }
.console.is-rail .console-nav-icon { font-size: 15px; width: auto; }
.console.is-rail .console-group-label { display: none; }
.console.is-rail .console-switcher { display: none; }         /* ActiveGemSwitcher — widen to use */
.console.is-rail .console-phase-btn { font-size: 0; }
.console.is-rail .console-phase-btn::before { content: attr(data-short); font-size: 12px; font-weight: 600; }
```

Note: `.console-brand { font-size: 0 }` collapses the "AgentGem" text run; the `<svg>` keeps its own size. The collapse button's glyph is re-sized explicitly above so it stays visible.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -C packages/console exec vitest run src/shell/Shell.test.tsx`
Expected: PASS (existing tests + the two new ones).

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/shell/Shell.tsx packages/console/src/shell/theme.css packages/console/src/shell/Shell.test.tsx
git commit -m "feat(console): collapsible/resizable/icon-rail sidebar in Shell"
```

---

### Task 4: `fullWidth` page flag + Studio full-width + Play→Studio rename

**Files:**
- Modify: `packages/console/src/contract.ts` (add field after line 22)
- Modify: `packages/console/src/shell/Shell.tsx` (the `<main>` element, line 178)
- Modify: `packages/console/src/shell/theme.css` (after `.console-main` line 204)
- Modify: `packages/console/src/panels/Play/index.tsx` (`playPage`, lines 87-92)
- Test: `packages/console/src/shell/Shell.test.tsx`

**Interfaces:**
- Consumes: `active.fullWidth` (new optional `ConsolePage` field).
- Produces: `<main>` gains `console-main--wide` when the active page sets `fullWidth`; `playPage.title === "Studio"`, `playPage.fullWidth === true`.

- [ ] **Step 1: Write the failing test** (append to `Shell.test.tsx`)

```tsx
describe("Shell — full-width pages + Studio rename", () => {
  const wide = p({ id: "studio", title: "Studio", phase: "build", category: "setup", order: 5, fullWidth: true });
  it("adds console-main--wide only for fullWidth pages", () => {
    const { container } = render(<Shell pages={[...pages, wide]} apiBase="" />);
    goHash("#/curate");
    expect(container.querySelector(".console-main--wide")).toBeNull();
    goHash("#/studio");
    expect(container.querySelector(".console-main--wide")).toBeTruthy();
  });
});
```

(Where `goHash` and `p` already exist at the top of the file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/console exec vitest run src/shell/Shell.test.tsx -t "full-width"`
Expected: FAIL — `fullWidth` not on `ConsolePage`; no `--wide` class.

- [ ] **Step 3a: Edit `contract.ts`** — add the field after `requiresGem?` (line 22):

```ts
  /** Nav item is dimmed ("locked") until a gem is active — for build stages that
   *  can't do anything without curated artifacts (Materialize/Deploy). */
  requiresGem?: boolean;
  /** Opt out of the default readable max-width; the panel fills available main width. */
  fullWidth?: boolean;
```

- [ ] **Step 3b: Edit `Shell.tsx`** — the `<main>` (line 178):

```tsx
        <main className={"console-main" + (active?.fullWidth ? " console-main--wide" : "")}>{ActivePage ? <ActivePage apiBase={apiBase} /> : null}</main>
```

- [ ] **Step 3c: Edit `theme.css`** — after `.console-main` (line 204):

```css
.console-main--wide { max-width: none; }
```

- [ ] **Step 3d: Edit `Play/index.tsx`** — `playPage` (lines 87-92):

```tsx
export const playPage = defineConsolePage({
  id: "play", title: "Studio", icon: "🎮", order: 35,
  phase: "build", category: "setup",
  route: "#/play",
  fullWidth: true,
  component: ({ apiBase }) => <Play apiBase={apiBase} />,
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -C packages/console exec vitest run src/shell/Shell.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/contract.ts packages/console/src/shell/Shell.tsx packages/console/src/shell/theme.css packages/console/src/panels/Play/index.tsx packages/console/src/shell/Shell.test.tsx
git commit -m "feat(console): full-width page flag; Studio fills width; rename Play→Studio"
```

---

### Task 5: `useSplit` + Studio preview↔chat divider

**Files:**
- Create: `packages/console/src/shell/useSplit.ts`
- Test: `packages/console/src/shell/useSplit.test.tsx`
- Modify: `packages/console/src/panels/Play/Studio.tsx` (the `.play-grid-2` block, lines 290-319)
- Modify: `packages/console/src/shell/theme.css` (`.play-grid-2` line 495 + new `.split-handle`)

**Interfaces:**
- Consumes: `useDragResize` from `./useDragResize.js`.
- Produces:
  - `useSplit(id: string, o: { initial: number; min: number; max: number; side?: "start" | "end" }): { containerProps: { ref: React.RefObject<HTMLDivElement>; style: React.CSSProperties; className: string }; handle: React.ReactElement }`
  - Persists the resizable pane's px size to `localStorage["agentgem.console.split." + id]`.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/console/src/shell/useSplit.test.tsx
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { useSplit } from "./useSplit.js";

afterEach(() => { cleanup(); localStorage.clear(); });

function Host() {
  const s = useSplit("studio", { initial: 500, min: 300, max: 800 });
  return (
    <div data-testid="box" {...s.containerProps}>
      {s.handle}
    </div>
  );
}

describe("useSplit", () => {
  it("seeds --split from initial and persists keyboard resizes", () => {
    render(<Host />);
    const box = screen.getByTestId("box");
    expect(box.style.getPropertyValue("--split")).toBe("500px");
    const sep = box.querySelector('[role="separator"]') as HTMLElement;
    fireEvent.keyDown(sep, { key: "ArrowRight" });
    expect(box.style.getPropertyValue("--split")).toBe("516px");
    expect(localStorage.getItem("agentgem.console.split.studio")).toBe("516");
  });
  it("restores a saved size on mount", () => {
    localStorage.setItem("agentgem.console.split.studio", "640");
    render(<Host />);
    expect(screen.getByTestId("box").style.getPropertyValue("--split")).toBe("640px");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/console exec vitest run src/shell/useSplit.test.tsx`
Expected: FAIL — cannot resolve `./useSplit.js`.

- [ ] **Step 3a: Write `useSplit.ts`**

```tsx
// packages/console/src/shell/useSplit.ts
import { useEffect, useRef, useState } from "react";
import { useDragResize } from "./useDragResize.js";

const keyFor = (id: string) => `agentgem.console.split.${id}`;

function load(id: string, fallback: number): number {
  try {
    const v = Number(localStorage.getItem(keyFor(id)));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  } catch { return fallback; }
}

export function useSplit(
  id: string,
  o: { initial: number; min: number; max: number; side?: "start" | "end" },
) {
  const [size, setSize] = useState(() => load(id, o.initial));
  useEffect(() => {
    try { localStorage.setItem(keyFor(id), String(size)); } catch { /* storage unavailable */ }
  }, [id, size]);

  const { dragging, handleProps } = useDragResize({
    value: size,
    min: o.min,
    max: o.max,
    onChange: setSize,
    invert: o.side === "end",
  });

  return {
    containerProps: {
      ref: useRef<HTMLDivElement>(null),
      style: { ["--split" as string]: `${size}px` } as React.CSSProperties,
      className: dragging ? "is-dragging" : "",
    },
    handle: <span className="split-handle" data-side={o.side ?? "start"} {...handleProps} />,
  };
}
```

- [ ] **Step 3b: Run the new unit test — verify pass**

Run: `pnpm -C packages/console exec vitest run src/shell/useSplit.test.tsx`
Expected: PASS.

- [ ] **Step 3c: Wire into `Studio.tsx`.** Import at top (after line 11):

```tsx
import { useSplit } from "../../shell/useSplit.js";
```

Inside `Studio`, after the other refs (~line 56, after `seededRef`):

```tsx
  const split = useSplit("studio", { initial: 560, min: 360, max: 900, side: "start" });
```

Change the grid open tag (line 290) from:

```tsx
      <div className="play-grid-2">
```

to:

```tsx
      <div className="play-grid-2" ref={split.containerProps.ref} style={split.containerProps.style} className={"play-grid-2" + (split.containerProps.className ? " " + split.containerProps.className : "")}>
```

⚠ A JSX element cannot have two `className` props. Write it as a single tag:

```tsx
      <div
        className={"play-grid-2" + (split.containerProps.className ? " " + split.containerProps.className : "")}
        ref={split.containerProps.ref}
        style={split.containerProps.style}
      >
```

Then insert the handle between the two panes — after the closing `</div>` of `.play-stage` and before `<div className="play-chat">` (between lines 303 and 304):

```tsx
        </div>
        {split.handle}
        <div className="play-chat">
```

- [ ] **Step 3d: Edit `theme.css`.** Replace `.play-grid-2` (line 495):

```css
.play-grid-2 { position: relative; display: grid; grid-template-columns: var(--split, 1.5fr) minmax(300px, 1fr); gap: 18px; align-items: stretch; }
```

Add the shared split-handle style right after it:

```css
/* Draggable divider between two panes. Absolutely positioned on the seam of its
   relatively-positioned container; --split feeds the resizable column. */
.split-handle {
  position: absolute; top: 0; bottom: 0; width: 12px; z-index: 3; cursor: col-resize;
  transform: translateX(-6px); border-radius: 6px;
}
.split-handle[data-side="start"] { left: var(--split); }
.split-handle[data-side="end"]   { right: var(--split); transform: translateX(6px); }
.split-handle::before {
  content: ""; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  width: 3px; height: 34px; border-radius: 3px; background: var(--line);
}
.split-handle:hover::before, .split-handle:focus-visible::before { background: var(--accent); }
.split-handle:focus-visible { outline: none; }
```

Note: the `gap: 18px` between columns means the `--split` column plus gap; the handle sits centered on the seam (`left: var(--split)` + `translateX(-6px)`) which lands in the gutter. Acceptable visually.

- [ ] **Step 4: Run the full console suite + build**

Run: `pnpm -C packages/console exec vitest run`
Expected: PASS (all suites).
Run: `pnpm -C packages/console exec tsc --noEmit` (typecheck)
Expected: no errors.
Run: `pnpm -C packages/console build`
Expected: bundle builds (catches the value-import-in-browser footgun).

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/shell/useSplit.ts packages/console/src/shell/useSplit.test.tsx packages/console/src/panels/Play/Studio.tsx packages/console/src/shell/theme.css
git commit -m "feat(console): draggable preview↔chat split in Studio via useSplit"
```

---

## Manual verification (after all tasks)

Run the console dev app and confirm end-to-end (the `/run` or `/verify` skill can drive this):
1. Drag the sidebar seam — main panel reflows live; drag narrow → snaps to a 56px icon rail with tooltips; drag wide → labels return. Reload → width persists.
2. `Cmd/Ctrl+B` (and the ⟨ button) hides the sidebar; the floating ☰ re-opens it.
3. Build phase nav item reads **Studio**; opening it shows a full-width two-pane layout; dragging the preview↔chat divider re-proportions the panes and persists on reload.
4. Zoom the window out (⌘−) — the Studio widens to fill; other panels stay capped at ~1100px.

## Self-review notes

- **Spec coverage:** Phase-1 sections A–E all mapped — A→Task 1, B→Tasks 2–3, C(studio row)→Task 5, D→Task 4, E→Task 4. Phase-2 splits intentionally omitted.
- **Type consistency:** `applyDrag`, `useDragResize`, `resolveWidth`, `isRail`, `RailState`, `useSidebar`, `useSplit` names/signatures identical across producer and consumer tasks.
- **Constants:** `RAIL_W=56`, `FULL_MIN=190`, `FULL_MAX=420`, `SNAP_THRESHOLD=130`, `DEFAULT_WIDTH=244` used verbatim.
