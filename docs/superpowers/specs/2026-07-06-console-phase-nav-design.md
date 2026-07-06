# Console navigation reorg — phase-primary IA

**Date:** 2026-07-06
**Status:** Design + eng reviewed (Variant B); ready to implement
**Scope:** `packages/console`. Mostly navigation/IA, plus three targeted panel-body touches:
the tabbed **Gems** wrapper, warm empty states on Gems › Yours + Market, and a first-run signpost
on Inspect. `GetGems` gets a small hash-reactivity change. No other panel internals change.

## Problem

The console sidebar is one flat list of ~19 items across four labelled sections
(Observe · Build · Library · Settings). All 19 render at once. The **Observe** section
alone holds 9 items and **Library** holds 6, so the sidebar reads as an undifferentiated
wall of links and the "what do I do next" story is lost.

## Goal

Re-organize navigation along two axes so that only a relevant subset shows at a time:

1. **Phase** (primary): `Observe → Build`. A phase switch at the top of the sidebar; only
   the active phase's screens render.
2. **Artifact** (secondary): `Setup · Sessions · Projects · Usage`. Within a phase, screens
   are grouped under these labels.

Visible-item count drops from 19-always to **≤11 (Observe)** / **≤8 (Build)**, grouped 2–3
per label.

## Approved layout (Variant B)

Phase switch renders `[ Observe | Build ]` at the top of the sidebar. Settings lives in the
phase-independent footer, unchanged.

### Observe — read across all four artifact types
| Category | Screens (in order) |
|---|---|
| Setup | Inspect, Rubrics |
| Sessions | Watch, Chat, Journey |
| Projects | Mine, Optimize |
| Usage | Insights, Benchmark |

### Build — assemble & ship gems
| Category | Screens (in order) |
|---|---|
| Setup | Curate, Sources, **Gems**, Rubrics |
| Projects | Materialize, Deploy, Publish |
| Sessions | — (empty, not rendered) |
| Usage | — (empty, not rendered) |

The grid is intentionally sparse: you Observe across all four artifact types, but Build only
touches Setup and Projects. Empty categories don't render (the Shell already guards empty
groups).

**Variant B consolidation:** the three gem-collection panels — `Your Gems` (`#/your-gems`),
`Received` (`#/received`), `Get Gems` (`#/get-gems`) — collapse into one **Gems** screen with
three tabs, cutting Build › Setup from six items to four. Rubrics stays as two separate
screens (one per phase); unifying it was Variant C, which we declined.

## Architecture

### 1. Contract change — two axes replace one `group`

`packages/console/src/contract.ts`. Replace the single `group` field:

```ts
export type Phase = "observe" | "build";
export type ArtifactCategory = "setup" | "sessions" | "projects" | "usage";

export interface ConsolePage {
  id: string;
  title: string;
  icon?: string;
  order: number;             // sort order WITHIN its (phase, category) bucket
  /** Phase this screen belongs to. Set with `category`, XOR with `footer`. */
  phase?: Phase;
  /** Artifact group within the phase. Set with `phase`. */
  category?: ArtifactCategory;
  /** Phase-independent footer item (Settings). XOR with phase/category. */
  footer?: boolean;
  requiresGem?: boolean;     // unchanged — dims until a gem is active
  route: string;
  component: (props: { apiBase: string }) => ReactNode;
}
```

**Strict two-sided guard (eng review OV2).** Every page is either `{ phase, category }` **or**
`{ footer: true }` — never neither, never only one of phase/category. Validated in `registry.ts`;
anything else throws. This is deliberate: in a 16-file mechanical migration, a page that lost its
`phase`/`category` field would otherwise silently become an invisible/footer item. Loud failure
beats a hidden nav bug. Only `Settings` sets `footer: true`.

### 2. Grouping helpers — `registry.ts`

Replace `groupedPages()` (which returned observe/build/library/settings) with two functions:

```ts
// Fixed category order for the sub-labels.
const CATEGORY_ORDER: ArtifactCategory[] = ["setup", "sessions", "projects", "usage"];

/** For one phase: ordered [{ category, pages }] groups, empty categories omitted. */
export function phaseGroups(pages: ConsolePage[], phase: Phase):
  { category: ArtifactCategory; pages: ConsolePage[] }[];

/** Pages with footer: true. */
export function footerPages(pages: ConsolePage[]): ConsolePage[];
```

`phaseGroups` keeps the existing duplicate-id guard and enforces the strict two-sided guard
above: throw if a page is missing `category` when phased, missing `phase` when categorized, or
has neither phase nor `footer`.

> **Test-rewrite note (eng review, Codex):** `groupedPages()` is deleted, and it's imported by
> `Shell.test.tsx:5`, `pages.test.ts:3`, and `__tests__/observeGroup.test.ts:2` — those tests are
> **rewritten**, not merely extended. Budget for it in T1.

### 3. Shell — phase derived from the route (eng review A1)

`packages/console/src/shell/Shell.tsx`. **Phase is NOT stored as state** — it is derived from
the active route, so there is exactly one source of truth (the hash) and no phase/hash desync.

- **Derived phase:** `phase = activePage.phase ?? phaseOf(lastActive) ?? "observe"`. `Shell.tsx:25`
  already derives `activePage` from the hash. **Footer pages have no phase (OV3):** on `Settings`,
  `activePage.phase` is undefined, so we fall back to the phase of the last *phased* route
  (`lastActive`) — clicking Settings from Build keeps the sidebar in Build, it does NOT snap to
  Observe.
- **Persisted state (localStorage), the only stored routing memory:**
  - `agentgem.console.lastActive` — the last **phased** active route (footer visits don't
    overwrite it), restored on reload.
  - `agentgem.console.lastRoute` — a `{ observe, build }` map, updated only when the active page is
    a real registered phased page (never the `ordered[0]` fallback). Defaults
    `{ observe: "#/inspect", build: "#/curate" }`.
  - **Validation (OV3):** stored values are validated against registered page routes on read;
    malformed JSON or an unknown/legacy route falls back to the default. Never persist an
    unresolved hash.
- **Cold-start / empty-hash precedence (OV3):** valid `lastActive` → else `#/inspect`. The
  active-page fallback is an **explicit default route** (`#/inspect`), not "lowest `order` in the
  registry" — per-bucket orders make a global-order fallback meaningless.
- **Phase switch (segmented control):** clicking a phase sets `window.location.hash =
  lastRoute[target]`. No `phase` state to set — the hash change re-derives everything.
- **Nav item click:** unchanged — sets `window.location.hash`.
- **Keyboard/ARIA:** the switch is built on the shared `useRovingTabIndex` primitive (§4a),
  `role="radiogroup"`, roving arrow keys, visible focus, ≥44px.
- **Render:** phase switch → (Build only) `ActiveGemSwitcher` → `phaseGroups(pages, phase)`
  mapped to a `<div class="console-group-label">` per category + its items → footer.

The existing element-vs-function-call rendering note and the longest-prefix route resolver are
preserved verbatim.

### 4a. Shared roving-tablist primitive (eng review CQ1)

`useRovingTabIndex({ items, selected, onSelect })` (or a tiny `<TabStrip>`) — one implementation
of the arrow-key roving + `aria-selected` + focus behavior, consumed by **both** the phase switch
(§3) and the Gems tab bar (§4). Written and tested once (DRY); Left/Right move selection,
Home/End jump to ends, focus clamps at the ends. Two real consumers, so not premature.

### 4. New tabbed Gems screen

`packages/console/src/panels/Gems/` — `index.ts` exports `gemsPage`, `Gems.tsx` renders the
tabbed shell.

- `gemsPage`: `{ id: "gems", title: "Gems", route: "#/gems", phase: "build", category: "setup", order: 30 }`.
- **Tabs are sub-routes** (deep-linkable). Tab selection uses the **path** portion only
  (`hash.split("?")[0]`), so `#/gems/market?install=x` still selects Market (OV4/Codex):
  - `#/gems` → **Yours** — reuses the `Workspaces` component body verbatim.
  - `#/gems/received` → **Received** — reuses the `Received` component body **verbatim: it is a
    ticket paste → redeem/apply form, NOT an inbox list** (verified `Received/index.tsx:16`). There
    is no server list of "gems shared to me", so no list, no warm empty state (the form is the
    content), and **no unread badge** (cut — no data source). The earlier mock's inbox was
    aspirational; disregard it.
  - `#/gems/market` → **Get more** — reuses the `GetGems` component body, with **one change**: its
    `?install=`/`?q=` parsing (`index.tsx:70`) becomes reactive to the hash instead of mount-only,
    so a mid-session `?install=` on the already-open Market tab fires (OV4).
- The Shell's longest-prefix resolver already routes `#/gems/received` to `gemsPage` (base
  `startsWith(route + "/")`). `Gems.tsx` reads `window.location.hash` to pick the active tab; the
  tab bar uses the shared `useRovingTabIndex` primitive (§4a).
- The three former page components move to plain exported components (drop their `*Page`
  wiring) and are imported by `Gems.tsx`. Their standalone `pages.tsx` entries are removed.
- **Lazy per-tab load via unmount-on-switch** (design review 2A + eng review OV4). Tabs are
  conditional-rendered: switching unmounts the old tab and mounts the new one, so a tab fetches on
  open and refetches on reopen (cheap; avoids stale data and keeps `GetGems`'s hash-reactive effect
  firing on mount). The Market tab does not fetch until first opened. No count badges in v1; the
  Received-inbox badge is **cut** (OV1 — no data source).

### 5. Route normalization — one path, right default (eng review A2)

Routing lives in **one place**. A pure `normalizeHash(hash): string` (in `registry.ts` or a small
`route.ts`) rewrites legacy routes to new ones. It is called on **both the initial resolve and the
Shell's existing `hashchange` handler** (`Shell.tsx:16`) — **initial matters (OV1/Codex): no
`hashchange` fires on first render, so a bookmarked `#/your-gems` would never normalize if we only
hooked `hashchange`.** No second listener in `main.tsx`.

| Legacy | New |
|---|---|
| `#/your-gems` | `#/gems` |
| `#/received` | `#/gems/received` |
| `#/get-gems?install=…&v=…` / `?q=…` | `#/gems/market?install=…&v=…` / `?q=…` |

- **Loop guard:** `normalizeHash` is idempotent — an already-normalized hash returns unchanged, so
  the rewrite can't re-trigger endlessly. The Shell only writes the hash back if it actually changed.
- **Query preserved verbatim**, so `GetGems`'s existing `window.location.hash.split("?")[1]`
  parsing (index.tsx:70) works unchanged on the market tab.
- **Cold-start default changes from `#/your-gems` to `#/inspect`.** `main.tsx:7` currently does
  `if (!window.location.hash) window.location.hash = "#/your-gems"` — post-reorg that would open a
  fresh launch in the **Build** phase on Gems, contradicting Observe→Build. Change the default to
  `#/inspect` (Observe › Setup). **This is a regression-guarded behavior change** (see Testing).

### 6. `pages.tsx` registration

Drop `workspacesPage`, `receivedPage`, `getGemsPage`; add `gemsPage`. Every remaining page gets
its `group` replaced with `{ phase, category }` per the mapping table below.

**`order` is reassigned per bucket.** Because `order` now sorts within a `(phase, category)`
bucket, the old global values are discarded and each bucket is numbered `10, 20, 30, …` to match
the sequence shown in the layout tables above. E.g. Build › Setup becomes Curate=10, Sources=20,
Gems=30, Rubrics=40 — otherwise the old Rubrics order (26) would sort ahead of Sources.

## Design decisions (design review 2026-07-06)

### Phase switch — segmented control (2A/5A)

Top of the sidebar, above `ActiveGemSwitcher`. A two-state **segmented control** styled with the
existing pill/token language (`.console-activegem` family in `theme.css`): `--paper-2` track,
`--raised` active thumb, `--accent` active text. Not full-width stacked tabs (too heavy for the
app's quiet chrome) and not clickable group-labels (fails "obviously clickable"). Reuses existing
tokens only — no new visual vocabulary.

### Gems interaction states (Pass 2)

Reference: `~/.gstack/projects/<slug>/designs/gems-screen-20260706/gems-screen.html` (all states).
Each tab wraps its existing component, whose `ledger-empty` / `ledger-error` states are upgraded
to the warm variants below.

| Tab | Loading | Empty | Error | Populated |
|---|---|---|---|---|
| Yours | skeleton rows | warm: "No gems yet — mine your first one" + `＋ New Gem` + "Browse marketplace →" + one line of context | inline `ledger-error` + **Retry**, reassure data is safe | list of gems, cert/draft chip, Open / Curate actions |
| Received | n/a (form) | n/a — the tab **is** a redeem/apply form (`Received/index.tsx`), not a list; no inbox/empty state | inline status on redeem failure (existing) | paste ticket → Redeem / Redeem privately / Apply-to-machine (existing form, verbatim) |
| Get more | skeleton rows (below the search box) | **registry not configured** → "Configure registry" + "What's a registry? →" (folds in the existing not-configured case) | search-failed inline error naming the query + Retry | search box + results, installs/version meta, Preview / Install |

Every empty state carries **warmth + one primary action + one line of context** (Design
Principle 1). Empty is a doorway, not "No items found."

### Empty & first-run (2B)

Beyond the Gems empties above, the **default landing screen** (Observe › Setup › Inspect) gets a
first-run signpost when the ledger is empty: a short line orienting a brand-new user ("Run an
agent, then come back to inspect what it did") instead of a blank pane. This is the very first
thing a new install shows.

### Accessibility & responsive (Pass 6)

- **Desktop-only, no responsive breakpoints.** The console is an Electron/desktop app with a fixed
  244px sidebar (`theme.css:52`). Responsive work is explicitly out of scope; the sidebar does not
  collapse. Stated so no one wonders.
- **Phase switch:** `role="radiogroup"` (or tablist) with roving **arrow-key** navigation,
  `aria-checked`/`aria-selected` on the active phase, visible `:focus-visible` ring, ≥44px targets.
- **Gems tab bar:** `role="tablist"`, each tab `role="tab"` with `aria-selected` and roving
  arrow-key focus; the panel is `role="tabpanel"`. Left/Right move selection; Home/End jump to
  first/last.
- Both controls reuse the existing `:focus-visible` accent ring. Keyboard users must be able to
  switch phase and tab without a mouse — today's flat nav is fully keyboardable and the reorg must
  not regress that.

## Full migration table

| id | route | old group | phase | category | notes |
|---|---|---|---|---|---|
| observe (Inspect) | `#/inspect` | observe | observe | setup | |
| rubrics | `#/rubrics` | observe | observe | setup | |
| watch | `#/watch` | observe | observe | sessions | |
| chat | `#/chat` | observe | observe | sessions | |
| dreaming (Journey) | `#/dreaming` | observe | observe | sessions | |
| mine | `#/mine` | observe | observe | projects | |
| optimize | `#/optimize` | observe | observe | projects | |
| insights | `#/insights` | observe | observe | usage | |
| benchmark | `#/benchmark` | observe | observe | usage | |
| curate | `#/curate` | build | build | setup | |
| sources | `#/sources` | library | build | setup | |
| **gems** (new) | `#/gems` | — | build | setup | wraps your-gems / received / get-gems |
| rubric-library (Rubrics) | `#/rubric-library` | library | build | setup | |
| materialize | `#/materialize` | build | build | projects | `requiresGem` |
| deploy | `#/deploy` | build | build | projects | `requiresGem` |
| publish | `#/publish` | library | build | projects | |
| settings | `#/settings` | settings | — (footer) | — | |
| ~~workspaces~~ | ~~`#/your-gems`~~ | library | → Gems tab "Yours" | | redirect |
| ~~received~~ | ~~`#/received`~~ | library | → Gems tab "Received" | | redirect |
| ~~get-gems~~ | ~~`#/get-gems`~~ | library | → Gems tab "Get more" | | redirect, preserves query |

## Error handling / edge cases

- **Empty category:** not rendered (guarded in `phaseGroups`, which omits empty groups).
- **Deep-link to a Build route while last phase was Observe:** the route's phase wins on init,
  so the sidebar opens in Build.
- **Unknown/legacy `localStorage` value:** validate against the `Phase` union; fall back to
  `"observe"`.
- **`requiresGem` dimming:** unchanged — Materialize/Deploy stay dimmed until a gem is active.
- **Install deep-link mid-session:** `#/get-gems?install=` redirect fires on `hashchange` too,
  so an in-app navigation to the legacy route still lands on the market tab with the banner.

## Testing

- **`registry.test`** (new/updated): `phaseGroups` buckets by category in `CATEGORY_ORDER`,
  omits empty categories, throws on a phased page missing `category`, keeps the duplicate-id
  guard; `footerPages` returns only Settings.
- **`Shell.test`** (extend existing): phase **derived** from the active route (deep-linking a Build
  route shows Build); switching phase sets hash to `lastRoute[phase]` and restores the last screen;
  `lastActive` restores on reload; footer renders Settings in both phases; empty Build categories
  don't render.
- **`normalizeHash.test`** (new): 3 legacy routes rewrite correctly on **both initial resolve and
  hashchange**; **`?install=&v=` / `?q=` preserved verbatim (CRITICAL)**; an already-normalized
  hash returns unchanged (loop guard); unknown routes pass through.
- **Contract-guard test:** throws on a phased page missing `category`, on a categorized page
  missing `phase`, and on a page with neither phase nor `footer`; `footerPages` returns only
  `footer:true` pages.
- **Phase-no-flip test:** navigating to `Settings` (footer) from Build keeps the sidebar in Build
  (phase falls back to `phaseOf(lastActive)`), does not snap to Observe.
- **`GetGems` reactivity test:** a `?install=` applied while already on `#/gems/market` fires the
  install (hash-reactive, not mount-only).
- **Storage-validation test:** malformed/legacy `lastActive`/`lastRoute` falls back to the default,
  never resolves to an unregistered route.
- **`Gems` test** (new): each sub-route selects the right tab; `#/gems/market?install=<k>`
  mounts the market tab and surfaces the install banner; a tab fetches only when opened, and the
  market tab does **not** fetch on mount (lazy).
- **`useRovingTabIndex.test`** (new): Left/Right move selection; Home/End jump to ends; focus
  clamps; `aria-selected` tracks. Both the phase switch and Gems tabs consume it.
- **Empty-state tests:** each Gems tab empty state renders a primary action; Inspect first-run
  signpost shows when the ledger is empty.
- **REGRESSION (mandatory, no decision):**
  1. empty hash resolves to `#/inspect` (Observe), not the old `#/your-gems` — the default changed.
  2. legacy bookmarks (`#/your-gems`, `#/received`, `#/get-gems?install=`) still resolve to their
     new screens — protects existing links and the Open-in-AgentGem flow.
- Full console suite green (run locally — CI skips console tests per project convention).

## What already exists (reuse, don't rebuild)

- **`theme.css` is the design system** (no `DESIGN.md`). Reuse `.console-nav-item`,
  `.console-group-label`, the `.console-activegem` pill family (for the phase switch), the
  staggered nav fade, and the paper/terracotta tokens. No new visual language.
- **`groupedPages()` / `sortedPages()`** in `registry.ts` — the phase helpers replace the former.
- **`ActiveGemSwitcher`** — unchanged, moves under the Build phase only.
- **`Workspaces` / `Received` / `GetGems` components** — reused verbatim as the three Gems tab
  bodies; only their `*Page` wiring is dropped. `GetGems` already parses `?install=`/`?q=` from
  the hash (index.tsx:70).
- **`ledger-empty` / `ledger-error` classes** — the empty/error scaffolding exists; the review
  only upgrades the copy/action, not the mechanism.

## Approved Mockups

| Screen/Section | Mockup Path | Direction | Notes |
|----------------|-------------|-----------|-------|
| Sidebar nav (phase-primary) | `~/.gstack/projects/<slug>/designs/nav-options-20260706.html` | Variant B — phase switch + 4 artifact groups, Gems merged | User-selected among A/B/C |
| Gems screen (all states) | `~/.gstack/projects/<slug>/designs/gems-screen-20260706/gems-screen.html` | Tabbed Yours/Received/Get-more, warm empties, skeleton loading, inline errors | Reference for Pass 2 states |

## Implementation Tasks

Synthesized from this review's findings. Each derives from a specific finding. P1 blocks ship,
P2 same branch, P3 follow-up.

- [ ] **T1 (P1, human: ~3h / CC: ~30min)** — contract + registry — split `group` into `phase` + `category`; add `phaseGroups`/`footerPages` with the missing-category guard.
  - Surfaced by: Architecture §1–§2
  - Files: `packages/console/src/contract.ts`, `registry.ts`, `registry.test.ts`
  - Verify: `pnpm --filter @agentgem/console test registry`
- [ ] **T2 (P1, human: ~4h / CC: ~40min)** — Shell — **derive** phase from route (no phase state); persist `lastActive` + per-phase `lastRoute`; segmented control on the shared `useRovingTabIndex` primitive (radiogroup, arrow keys, focus, 44px).
  - Surfaced by: Architecture §3, eng review A1/CQ1, Pass 5A/6A
  - Files: `packages/console/src/shell/Shell.tsx`, `useRovingTabIndex.ts`, `theme.css`, `Shell.test.tsx`
  - Verify: `pnpm --filter @agentgem/console test Shell`
- [ ] **T3 (P1, human: ~3h / CC: ~30min)** — Gems screen — new `panels/Gems/` tabbed wrapper (tab bar reuses `useRovingTabIndex`), lazy per-tab load, wraps the three existing components.
  - Surfaced by: Architecture §4, eng review CQ1, Pass 2 (2A), Pass 6A
  - Files: `packages/console/src/panels/Gems/`, `pages.tsx`
  - Verify: `pnpm --filter @agentgem/console test Gems`
- [ ] **T4 (P1, human: ~1h / CC: ~15min)** — routing — one idempotent `normalizeHash()` called by the Shell (no 2nd listener); rewrite 3 legacy routes preserving `?install=`/`?q=`; change cold-start default `#/your-gems` → `#/inspect`; 2 regression tests.
  - Surfaced by: Architecture §5, eng review A2
  - Files: `packages/console/src/registry.ts` (or `route.ts`), `main.tsx`, `Shell.tsx`, `normalizeHash.test.ts`
  - Verify: deep-link `#/get-gems?install=k&v=1` lands on market tab with banner; empty hash → `#/inspect`
- [ ] **T5 (P2, human: ~2h / CC: ~20min)** — warm empty states — upgrade **Yours** empty (action + context) + Market "registry not configured" + Inspect first-run signpost. (Received is a form, not a list — no empty state.)
  - Surfaced by: Pass 2 (2B), eng review OV1
  - Files: `panels/Workspaces/`, `panels/GetGems/`, `panels/Observe/`
  - Verify: render each empty state, confirm a primary action is present

_T6 (Received unread badge) cut — the Received panel is a redeem form with no inbox data source (eng review OV1)._

## Out of scope

- No panel-body redesigns beyond wrapping the three gem panels in tabs.
- No Rubrics unification (that was Variant C — twin "Rubrics" labels across phases accepted).
- No new screens for the empty Build › Sessions / Usage cells.
- No responsive/mobile breakpoints — desktop Electron app, fixed sidebar.
- All Gems tab count badges cut (incl. the Received unread badge — no inbox data source exists).
- No received-gem inbox — the Received tab stays the existing redeem/apply form.
- The twin "Rubrics" labels (Observe vs Build) keep identical text; disambiguating copy is a
  possible future polish, not in scope (noted by the outside voice for search/SR ambiguity).

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_found | outside voice: ~18 raised, 4 forks + fixes folded |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | 7 issues, 0 critical gaps, all folded |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | clean | score: 6/10 → 9/10, 4 decisions |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **CODEX:** outside voice caught a P1 (cold-start normalization won't fire without a hashchange), a P1 (derive-phase flips on Settings), and the fact that `Received` is a redeem form not an inbox — all folded into the spec.
- **CROSS-MODEL:** no live tension — the outside voice found gaps the review missed rather than contradicting it; all 4 forks resolved with the user.
- **VERDICT:** ENG + DESIGN CLEARED — ready to implement.

NO UNRESOLVED DECISIONS
