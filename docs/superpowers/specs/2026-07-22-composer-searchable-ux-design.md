# Composer Searchable UX — Design

**Date:** 2026-07-22
**Status:** Approved (design), pre-implementation
**Scope:** `packages/console/src/panels/Play/Composer.tsx` — replace the stacked flat lists
(capabilities, MCP connectors, project/session/skill sources) with searchable / collapsed
affordances. No server routes change; the post-save `CapabilityStrip` is untouched.

## Problem

The Composer stacks four lists vertically, three of them unbounded:

1. **Capabilities** — 8 fixed `CONSENT_CAPS` checkboxes (`Composer.tsx:155-163`).
2. **MCP connectors** — the candidate picker (variable, 11+ servers observed live).
3. **Source** — Project / Session / Skill each render a `play-src` `<ul>` (`Composer.tsx:179-214`)
   that grows to however many projects/sessions/skills exist.

All four compete for vertical space above/around the primary action, and the source lists
have no way to find an item other than scroll.

## Ordering constraint (drives the layout)

In Project/Session/Skill, clicking a source row **fires create-and-seed immediately**
(`seed()` → `playStudioRoute` → `onCreated`, reading the current `caps`/`connectors` to build
the preamble). So the optional intent (caps + connectors) MUST be set *before* the source
pick. The advanced/options band therefore stays **above** the source list — it is only made
compact, not moved below.

## Design

### Layout (new order)

```
Agent selector
┌ Options band (compact) ──────────────────────────────────┐
│ Permissions  [N enabled ▸]      ← collapsed disclosure    │
│ Connectors   [github ⚠ ×][context7 ×]   [ + ▾ ]           │
└───────────────────────────────────────────────────────────┘
[Project][Session][Skill][HTML][Blank]     name (optional)…
🔍 search projects…
 • /p/foo   node          ← primary, always visible, capped scroll
 • /p/bar   python
```

### 1. Source picker — `SourceList` (searchable-inline, extracted component)

New `packages/console/src/panels/Play/SourceList.tsx`. Generic over the row type:

```ts
interface SourceListProps<T> {
  items: T[] | null;                       // null = loading
  filter: (item: T, q: string) => boolean; // case-insensitive substring, caller-defined
  onPick: (item: T) => void;               // fires seed()
  renderRow: (item: T) => { main: string; meta?: string };
  placeholder: string;                     // e.g. "search projects…"
  loadingLabel: string;                    // e.g. "Loading projects…"
}
```

- A search `<input>` with the filtered list always shown beneath (never a closed dropdown —
  the primary action stays discoverable).
- Filtering: case-insensitive substring; Project = `path`+`flavor`, Session = the
  `sessionSummary(s)` text, Skill = `name`+`description`.
- Capped `max-height` scroll on the list; **"No matches"** row when the filter empties it;
  the existing "Loading …" line while `items == null`.
- Keyboard: `↓`/`↑` move a highlighted row, `Enter` picks the highlight (calls `onPick` →
  `seed`), `Esc` clears the query. Mouse click still picks directly.
- Session's Replay/Heatmap genre toggle stays rendered *above* its `SourceList`.
- HTML and Blank tabs are forms with no list — unchanged.

### 2. Connector picker — `ConnectorPicker` (chips + searchable combobox, extracted)

New `packages/console/src/panels/Play/ConnectorPicker.tsx`, absorbing the current inline
picker: the candidates fetch, `loadTools`, `toolsByServer`, the needs-secret guard, the
`Candidate`/`ToolState` types, AND the `connectorPreamble` helper (re-exported for Composer).
Props:

```ts
interface ConnectorPickerProps {
  apiBase: string;
  selected: string[];                       // server names
  onChange: (servers: string[]) => void;
}
```

- **Selected** connectors render as chips: `server` + `⚠` when the candidate is `needsSecret`
  + a `×` remove control. Clicking the chip **body** toggles an inline tools panel for that
  server, reusing `loadTools(candidate, force?)` + `toolsByServer` + the needs-secret
  "Try anyway" (the shipped `/candidate-tools` path — unchanged behavior, new home).
- A `+ ▾` button opens a **searchable menu**: a search `<input>` + the filtered candidate
  list (each row: `server`, transport, `needs secret` badge). Picking a row adds it to
  `selected` and closes the menu. Already-selected servers are **omitted** from the menu
  (they are already visible as chips); an empty menu after all are picked shows "all
  connectors added".
- Empty candidates (`/candidates` → `[]`) → the existing copy "No MCP servers found in your
  agent setup. Add one to `~/.claude/.mcp.json` …" shown in place of the `+ ▾` menu contents.
- ARIA: `+ ▾` is `aria-haspopup="listbox" aria-expanded`; menu is `role="listbox"`, rows
  `role="option"`; `Esc` and click-outside close; the chip tools toggle keeps the shipped
  `aria-expanded`/`aria-controls` pattern.

`connectorPreamble(servers)` and the `Candidate`/`ToolState` types move into
`ConnectorPicker.tsx`; Composer imports `connectorPreamble` from there (it still composes the
seed/blank preambles). This keeps the intent-only contract intact (picker never writes
`meta.json`).

### 3. Capabilities — collapsed disclosure (stays in Composer)

The 8 `CONSENT_CAPS` checkboxes move behind a disclosure:

```
Permissions  [N enabled ▸]     ← <button aria-expanded>, N = caps.length
   (expanded) → today's exact 8 <label><input type=checkbox>…</label> rows
```

- Collapsed by default (most miniapps enable none); the `N enabled` count keeps enabled
  permissions visible even when collapsed, so a granted permission is never fully hidden.
- No combobox here on purpose: a fixed set of 8 security-relevant, educational labels gains
  nothing from search and loses at-a-glance legibility.

## Files changed

- Create: `packages/console/src/panels/Play/SourceList.tsx`
- Create: `packages/console/src/panels/Play/ConnectorPicker.tsx`
- Modify: `packages/console/src/panels/Play/Composer.tsx` — render the Options band (caps
  disclosure + `<ConnectorPicker>`), wire `<SourceList>` into the Project/Session/Skill tabs,
  drop the old inline `play-src`/`play-connectors-pick` markup and the picker state that moved
  into `ConnectorPicker`. `seed()`/`doBlank()` still compose `[capPreamble(caps),
  connectorPreamble(connectors), …]`.
- Modify: `packages/console/src/shell/theme.css` — new `play-*` classes (search input, source
  list, "no matches", connector chips, combobox menu, permissions disclosure) each with a rule
  reusing `--accent`/`--muted`/`--line`/`--line-soft`/`--font-mono`.

## Testing (console vitest, repo style: `.toBeTruthy()` + DOM `getAttribute`, `vi.spyOn` routes)

- **`SourceList.test.tsx`**: typing filters rows (substring, case-insensitive); "No matches"
  when nothing matches; `↓`+`Enter` picks the highlighted row (`onPick` called with it);
  loading label while `items == null`.
- **`ConnectorPicker.test.tsx`**: `+ ▾` opens the searchable menu; typing filters candidates;
  picking adds a chip + calls `onChange`; `×` removes; clicking a chip lazily fetches tools
  once (`aria-expanded` flips); a needs-secret candidate does not auto-connect on chip expand.
- **`Composer.connectors.test.tsx`** (existing — update selectors): still emits a
  `connectorPreamble` containing `- <server>` on seed after a pick; caps disclosure expands to
  the checkboxes and a checked cap still reaches `capPreamble`.
- CSS enforcement: every new `play-*` class resolves to a rule in `theme.css`.

## Out of scope

- HTML/Blank form tabs (no lists).
- Post-save `CapabilityStrip` (unchanged).
- Server routes `/candidates`, `/candidate-tools`, `/servers`, `/studio` (all reused as-is).
- Turning the source pick into a *closed* dropdown — rejected: it hides the Composer's
  primary action behind a click (discoverability regression).
