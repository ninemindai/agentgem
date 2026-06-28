# Console IA Redesign — Phase 1: Grouped Shell + Active-Gem Store

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lay the foundation for the journey IA — a grouped sidebar (BUILD / LIBRARY / Settings) and a shared **active-Gem store** — without yet splitting any panels. The app stays fully working; only the nav grouping changes and the Ledger's selection state moves into the shared store.

**Architecture:** Add an optional `group` to the `ConsolePage` contract and teach `Shell` to render labeled sections. Introduce `activeGem.ts` — a tiny subscribable store (the gem-in-progress: selection keys + name) consumed via a `useActiveGem()` hook. Re-point the existing `Ledger` panel at that store so the store is the source of truth before later phases split Curate/Materialize/Deploy out of it.

**Tech Stack:** React 19 (`useSyncExternalStore`), TypeScript, vitest 4 + @testing-library/react (jsdom). Existing `packages/console` workspace.

## Global Constraints

- Work only in `packages/console`. No server/API changes in Phase 1.
- The app must stay green and usable after every task — no half-migrated nav.
- Follow existing patterns: `defineConsolePage` registry, one-import-per-panel in `pages.tsx`, warm-letterpress theme classes in `shell/theme.css`. Do NOT change the visual theme.
- The active-Gem store mirrors the simplicity of the existing `packages/console/src/recommendation.ts` hand-off, but is **subscribable** (multiple panels will read it in later phases).
- Tests run with `pnpm -F @agentgem/console test`; typecheck with `pnpm -F @agentgem/console typecheck`.
- Git author for every commit: `Raymond Feng <raymond@ninemind.ai>`; end messages with the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer.

---

### Task 1: Grouped sidebar shell

Add nav groups to the contract and render them as labeled sections, with Settings pinned to the footer. Assign the existing 6 panels to interim groups (the real stage-split comes in Phases 2–3). Also remove the dead `/legacy` link (that route was deleted).

**Files:**
- Modify: `packages/console/src/contract.ts`
- Modify: `packages/console/src/registry.ts`
- Modify: `packages/console/src/shell/Shell.tsx`
- Modify: `packages/console/src/shell/theme.css`
- Modify: `packages/console/src/pages.tsx`
- Modify: `packages/console/src/pages.test.ts`
- Test: `packages/console/src/shell/Shell.test.tsx`

**Interfaces:**
- Produces: `ConsolePage.group?: "build" | "library" | "settings"`. `groupedPages(pages): { build: ConsolePage[]; library: ConsolePage[]; settings: ConsolePage[] }` — each list sorted by `order`; pages with no `group` default to `"build"`.

- [ ] **Step 1: Add `group` to the contract**

In `packages/console/src/contract.ts`, add the field to `ConsolePage`:
```ts
export interface ConsolePage {
  id: string;
  title: string;
  icon?: string;
  order: number;
  /** Sidebar group; defaults to "build". */
  group?: "build" | "library" | "settings";
  /** Hash route, e.g. '#/ledger'. */
  route: string;
  component: (props: { apiBase: string }) => ReactNode;
}
```

- [ ] **Step 2: Write the failing test for `groupedPages`**

In `packages/console/src/shell/Shell.test.tsx`, add at the top (keep existing tests):
```tsx
import { groupedPages } from "../registry.js";
import { defineConsolePage } from "../registry.js";

describe("groupedPages", () => {
  const p = (id: string, order: number, group?: "build" | "library" | "settings") =>
    defineConsolePage({ id, title: id, order, group, route: `#/${id}`, component: () => null });

  it("buckets by group (default build), each sorted by order", () => {
    const g = groupedPages([p("b", 20), p("a", 10), p("lib", 5, "library"), p("set", 1, "settings")]);
    expect(g.build.map((x) => x.id)).toEqual(["a", "b"]);
    expect(g.library.map((x) => x.id)).toEqual(["lib"]);
    expect(g.settings.map((x) => x.id)).toEqual(["set"]);
  });
});
```

- [ ] **Step 3: Run it — expect FAIL**

Run: `pnpm -F @agentgem/console test -t groupedPages`
Expected: FAIL — `groupedPages is not a function`.

- [ ] **Step 4: Implement `groupedPages`**

In `packages/console/src/registry.ts`, append:
```ts
/** Bucket pages into the three sidebar sections, each sorted by order. */
export function groupedPages(pages: ConsolePage[]): {
  build: ConsolePage[];
  library: ConsolePage[];
  settings: ConsolePage[];
} {
  // Reuse sortedPages for its duplicate-id guard, then bucket.
  const ordered = sortedPages(pages);
  return {
    build: ordered.filter((p) => (p.group ?? "build") === "build"),
    library: ordered.filter((p) => p.group === "library"),
    settings: ordered.filter((p) => p.group === "settings"),
  };
}
```

- [ ] **Step 5: Run it — expect PASS**

Run: `pnpm -F @agentgem/console test -t groupedPages`
Expected: PASS.

- [ ] **Step 6: Render groups in the Shell**

Rewrite `packages/console/src/shell/Shell.tsx` to render the three sections and drop the dead `/legacy` link:
```tsx
import { useEffect, useState } from "react";
import { groupedPages, sortedPages, type ConsolePage } from "../registry.js";

export function Shell({ pages, apiBase }: { pages: ConsolePage[]; apiBase: string }) {
  const groups = groupedPages(pages);
  const ordered = sortedPages(pages);
  const [hash, setHash] = useState(() => window.location.hash);

  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const active = ordered.find((p) => p.route === hash) ?? ordered[0];

  const item = (p: ConsolePage) => (
    <button
      key={p.id}
      className={"console-nav-item" + (p === active ? " is-active" : "")}
      onClick={() => { window.location.hash = p.route; }}
    >
      {p.icon ? <span className="console-nav-icon">{p.icon}</span> : null}
      {p.title}
    </button>
  );

  return (
    <div className="console">
      <nav className="console-nav">
        <div className="console-brand">
          <svg className="console-mark" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M6 3h12l4 6-10 12L2 9l4-6Z" fill="currentColor" fillOpacity=".14" />
            <path d="M6 3h12l4 6-10 12L2 9l4-6Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
            <path d="M2 9h20M9 3 7 9l5 12M15 3l2 6-5 12" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" opacity=".7" />
          </svg>
          AgentGem
        </div>
        <div className="console-group-label">Build</div>
        {groups.build.map(item)}
        {groups.library.length > 0 && <div className="console-group-label">Library</div>}
        {groups.library.map(item)}
        <div className="console-footer">{groups.settings.map(item)}</div>
      </nav>
      <main className="console-main">{active?.component({ apiBase })}</main>
    </div>
  );
}
```

- [ ] **Step 7: Add the group-label + footer styles**

Append to `packages/console/src/shell/theme.css`:
```css
.console-group-label { margin: 14px 8px 4px; font: 700 10px/1 var(--font-ui);
  text-transform: uppercase; letter-spacing: .16em; color: var(--muted); }
.console-group-label:first-of-type { margin-top: 6px; }
.console-footer { margin-top: auto; padding-top: 8px; border-top: 1px solid var(--line-soft); }
```

- [ ] **Step 8: Assign groups in `pages.tsx`**

The existing panels keep their `order`; we only add interim `group` assignments by editing each panel's `defineConsolePage` call. For Phase 1, set the `group` field on each page object. Edit the six panel files' `defineConsolePage({...})` to add `group`:
- `panels/Ledger/index.tsx` → `group: "build"`
- `panels/Testbed/index.tsx` → `group: "build"`
- `panels/Workspaces/index.tsx` → `group: "library"`
- `panels/GetGems/index.tsx` → `group: "library"`
- `panels/Transfer/index.tsx` → `group: "library"`
- `panels/Deploy/index.tsx` → `group: "settings"`

Example edit (Ledger), find the `defineConsolePage({` for `ledgerPage` and add the line after `order`:
```tsx
export const ledgerPage = defineConsolePage({
  id: "ledger",
  title: "Ledger",
  icon: "◆",
  order: 10,
  group: "build",
  route: "#/ledger",
  component: ({ apiBase }) => <Ledger apiBase={apiBase} />,
});
```
Apply the analogous one-line `group:` addition to the other five panels.

- [ ] **Step 9: Add a Shell render test for grouping**

In `packages/console/src/shell/Shell.test.tsx`, add inside the existing `describe("Shell", …)` (it already imports render/screen):
```tsx
it("renders group labels and places items under them", () => {
  const pages = [
    defineConsolePage({ id: "a", title: "Build A", order: 10, group: "build", route: "#/a", component: () => <p>pa</p> }),
    defineConsolePage({ id: "l", title: "Lib L", order: 10, group: "library", route: "#/l", component: () => <p>pl</p> }),
    defineConsolePage({ id: "s", title: "Settings", order: 10, group: "settings", route: "#/s", component: () => <p>ps</p> }),
  ];
  render(<Shell pages={pages} apiBase="" />);
  expect(screen.getByText("Build")).toBeTruthy();
  expect(screen.getByText("Library")).toBeTruthy();
  expect(screen.getByText("Build A")).toBeTruthy();
  expect(screen.getByText("Settings")).toBeTruthy();
});
```

- [ ] **Step 10: Update `pages.test.ts` to assert groups**

The existing `pages.test.ts` checks ids in `order`. Add an assertion that grouping is wired:
```ts
import { groupedPages } from "./registry.js";

it("assigns each page to a sidebar group", () => {
  const g = groupedPages(pages);
  expect(g.build.map((p) => p.id)).toEqual(["testbed", "ledger"]);
  expect(g.library.map((p) => p.id)).toEqual(["workspaces", "get-gems", "transfer"]);
  expect(g.settings.map((p) => p.id)).toEqual(["deploy"]);
});
```
(Verified against the panel files: orders are testbed 5, ledger 10, workspaces 20, get-gems 30, deploy 40, transfer 45 — so the buckets above are exact.)

- [ ] **Step 11: Run the full console suite + typecheck**

Run: `pnpm -F @agentgem/console typecheck && pnpm -F @agentgem/console test`
Expected: all green (existing + new tests).

- [ ] **Step 12: Commit**

```bash
git add packages/console/src/contract.ts packages/console/src/registry.ts \
  packages/console/src/shell/Shell.tsx packages/console/src/shell/Shell.test.tsx \
  packages/console/src/shell/theme.css packages/console/src/pages.tsx packages/console/src/pages.test.ts \
  packages/console/src/panels/*/index.tsx
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(console): grouped sidebar (Build/Library/Settings); drop dead /legacy link

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Active-Gem store

A small subscribable store for the gem-in-progress: the selection keys (e.g. `"skills::pdf"`) and the gem name. Later phases' Curate/Materialize/Deploy panels all read it. Modeled on `recommendation.ts` but with subscription so multiple components stay in sync.

**Files:**
- Create: `packages/console/src/activeGem.ts`
- Test: `packages/console/src/activeGem.test.ts`

**Interfaces:**
- Produces:
  - `useActiveGem(): { keys: Set<string>; name: string }` — React hook (re-renders on change).
  - `setKeys(keys: Set<string>): void`, `toggleKey(key: string): void`, `clearKeys(): void`, `setName(name: string): void`, `resetGem(): void` (clears keys + name).
  - `getKeys(): Set<string>`, `getName(): string` (non-reactive reads for event handlers).

- [ ] **Step 1: Write the failing test**

`packages/console/src/activeGem.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { setKeys, toggleKey, clearKeys, setName, resetGem, getKeys, getName, subscribe } from "./activeGem.js";

beforeEach(() => resetGem());

describe("activeGem store", () => {
  it("set / toggle / clear keys", () => {
    setKeys(new Set(["skills::pdf"]));
    expect([...getKeys()]).toEqual(["skills::pdf"]);
    toggleKey("skills::csv");
    expect(getKeys().has("skills::csv")).toBe(true);
    toggleKey("skills::pdf");
    expect(getKeys().has("skills::pdf")).toBe(false);
    clearKeys();
    expect(getKeys().size).toBe(0);
  });

  it("name + resetGem", () => {
    setName("my-gem");
    setKeys(new Set(["skills::pdf"]));
    expect(getName()).toBe("my-gem");
    resetGem();
    expect(getName()).toBe("");
    expect(getKeys().size).toBe(0);
  });

  it("notifies subscribers", () => {
    let hits = 0;
    const unsub = subscribe(() => { hits++; });
    setName("x");
    toggleKey("a");
    unsub();
    setName("y");
    expect(hits).toBe(2); // not 3 — unsubscribed before the last
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `pnpm -F @agentgem/console test activeGem`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the store**

`packages/console/src/activeGem.ts`:
```ts
import { useSyncExternalStore } from "react";

// The gem-in-progress: which inventory items are selected (group::name keys) and
// the gem's name. Shared by Curate/Materialize/Deploy so the active Gem carries
// across stages. A single module-level store with subscription.
let keys: Set<string> = new Set();
let name = "";
const listeners = new Set<() => void>();

function emit() { for (const l of listeners) l(); }

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getKeys(): Set<string> { return keys; }
export function getName(): string { return name; }

export function setKeys(next: Set<string>): void { keys = new Set(next); emit(); }
export function toggleKey(key: string): void {
  const next = new Set(keys);
  if (next.has(key)) next.delete(key); else next.add(key);
  keys = next; emit();
}
export function clearKeys(): void { keys = new Set(); emit(); }
export function setName(next: string): void { name = next; emit(); }
export function resetGem(): void { keys = new Set(); name = ""; emit(); }

/** React hook: re-renders the caller whenever the active gem changes. */
export function useActiveGem(): { keys: Set<string>; name: string } {
  const snap = useSyncExternalStore(subscribe, () => stableSnapshot());
  return snap;
}

// useSyncExternalStore requires a stable snapshot reference between renders when
// nothing changed; rebuild only on emit by caching the last (keys,name) tuple.
let snapshot = { keys, name };
function stableSnapshot() {
  if (snapshot.keys !== keys || snapshot.name !== name) snapshot = { keys, name };
  return snapshot;
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `pnpm -F @agentgem/console test activeGem`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -F @agentgem/console typecheck
git add packages/console/src/activeGem.ts packages/console/src/activeGem.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(console): active-Gem store (shared selection + name, subscribable)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Point the Ledger at the active-Gem store

Replace the Ledger's local `selected`/`wsName` state with the shared store via `useActiveGem()`. This proves the store end-to-end while the Ledger is still one page (the split happens in Phase 2). Behavior is unchanged; existing Ledger tests must still pass.

**Files:**
- Modify: `packages/console/src/panels/Ledger/index.tsx`
- (No test file changes expected — existing `Ledger.test.tsx` is the regression guard.)

**Interfaces:**
- Consumes: `useActiveGem`, `setKeys`, `toggleKey`, `clearKeys`, `setName` from `../../activeGem.js` (Task 2).

- [ ] **Step 1: Import the store**

In `packages/console/src/panels/Ledger/index.tsx`, add to the imports:
```tsx
import { useActiveGem, setKeys, toggleKey as toggleKeyStore, clearKeys, setName as setNameStore } from "../../activeGem.js";
```

- [ ] **Step 2: Replace the two local states with the store**

Find these two lines in the component body:
```tsx
  const [selected, setSelected] = useState<Set<string>>(new Set());
```
and
```tsx
  const [wsName, setWsName] = useState("");
```
Replace BOTH with a single read from the store (delete the two `useState` lines and add):
```tsx
  const { keys: selected, name: wsName } = useActiveGem();
```

- [ ] **Step 3: Re-point the mutators**

Update the handlers that mutated the old local state so they call the store. Apply these exact substitutions inside `index.tsx`:

- `toggle`:
  ```tsx
  const toggle = (key: string) => toggleKeyStore(key);
  ```
- `selectAllShown`:
  ```tsx
  const selectAllShown = () => setKeys(new Set([...selected, ...visibleKeys(visible)]));
  ```
- `clearSelection`:
  ```tsx
  const clearSelection = () => clearKeys();
  ```
- The workspace-name input `onChange` (currently `setWsName(e.target.value)`):
  ```tsx
  onChange={(e) => setNameStore(e.target.value)}
  ```
- After a successful save, where it did `setWsName("")`, use:
  ```tsx
  setNameStore("");
  ```
- The recommendation effect currently does `setSelected(new Set(keys))`; change to:
  ```tsx
  setKeys(new Set(keys));
  ```
- Any other `setSelected(...)` call → `setKeys(...)`; any other `setWsName(...)` → `setNameStore(...)`.

(Search the file for `setSelected` and `setWsName` and confirm every occurrence is converted. There should be no remaining references to `setSelected`/`setWsName` after this step.)

- [ ] **Step 4: Reset the gem when the Ledger mounts fresh? No — leave persistence**

Do NOT reset on mount; the store intentionally persists the in-progress gem across navigation (that's the point). Leave it. (Phase 3 adds an explicit "New Gem" control.)

- [ ] **Step 5: Typecheck**

Run: `pnpm -F @agentgem/console typecheck`
Expected: clean. If TS flags an unused `useState` import, it's still used by other Ledger state — leave it.

- [ ] **Step 6: Run the Ledger regression tests**

Run: `pnpm -F @agentgem/console test Ledger`
Expected: PASS — selection, build, save-workspace, checks, import all still work (now via the store). If the "saves the current selection as a workspace" or "clears the selection" tests fail, the cause is almost always a missed `setSelected`/`setWsName` → store conversion in Step 3; fix and re-run.

- [ ] **Step 7: Full suite + browser smoke**

Run: `pnpm -F @agentgem/console test`
Expected: all green.

Then build + run and confirm the build flow still works against the real API:
```bash
pnpm build && (PORT=4317 node dist/index.js &) && sleep 3
# open http://127.0.0.1:4317/#/ledger : search → check items → Build Gem → preview appears
```

- [ ] **Step 8: Commit**

```bash
git add packages/console/src/panels/Ledger/index.tsx
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "refactor(console): Ledger reads selection + name from the active-Gem store

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] `pnpm -F @agentgem/console typecheck` clean.
- [ ] `pnpm -F @agentgem/console test` green (incl. new groupedPages, Shell grouping, activeGem tests).
- [ ] `pnpm build` succeeds; `dist/public/console/index.html` present.
- [ ] In-browser: sidebar shows **Build** / **Library** labels with the 6 panels bucketed under them and Deploy at the footer; the dead "Classic UI ↗" link is gone; the Ledger build flow works unchanged.

## What Phase 1 deliberately does NOT do (Phases 2–3)

- It does NOT split the Ledger into Curate/Materialize stages, add the Global/Project scope picker, move Analyze out of Testbed, or remove Testbed. Those are **Phase 2**.
- It does NOT create the Deploy stage, rename Workspaces → Your Gems, wire Transfer's Send into Materialize / Redeem into Received, or add the active-Gem pin + landing-on-Curate. Those are **Phase 3**.
- The interim grouping (Ledger+Testbed under Build; Workspaces+GetGems+Transfer under Library; Deploy under Settings) is a stepping stone — the panels are renamed/split in later phases.

## Self-review notes (spec coverage)

- Spec "grouped-sidebar layout (BUILD / LIBRARY / Settings)" → Task 1.
- Spec "active-Gem store (selection/name) shared by stages; modeled on recommendation.ts" → Task 2.
- Spec "central refactor: selection state lifted out of Ledger-local state" → Task 3.
- Spec "drop dead /legacy" (implicit — Shell had a `/legacy` link to a deleted route) → Task 1 Step 6.
- Stage split, scope picker, Testbed removal, Deploy stage, Library rename, Transfer absorption, active-Gem pin, landing → explicitly deferred to Phases 2–3 (documented above).
