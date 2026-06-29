# Insights UI Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add leaderboard search and an Insights→Get Gems deep-link to the console Insights panel.

**Architecture:** Search is a pure client-side filter over the already-loaded `popularity` rows (no backend call); rank and bar scale stay tied to the full list. The cross-panel deep-link passes the ingredient name through a tiny module-level intent store (the exact-match hash router has no query support) and navigates to the clean `#/get-gems`, where Get Gems consumes the pending query once on mount.

**Tech Stack:** React 19, TypeScript (ESM, `.js` import specifiers), Vitest + @testing-library/react (jsdom).

## Global Constraints

- Import specifiers use the `.js` extension even for `.ts`/`.tsx` sources (ESM/NodeNext). Copy the existing files' style.
- Tests run from `packages/console` via `pnpm test` (vitest, `environment: jsdom`, exact-include `src/**/*.test.{ts,tsx}`).
- `AggIngredient` = `{ id: string; kind: string; producers: number; verifiedProducers: number; invocations: number; sessions: number }` (from `../../api/routes.js`).
- Component tests stub `globalThis.fetch` with `vi.stubGlobal` and a `res(body)` helper returning `{ ok, status, text: async () => JSON.stringify(body) }`; routes are matched by URL substring.
- CSS lives in `packages/console/src/shell/theme.css`; reuse existing `ins-*` / `ledger-*` class conventions.
- Do NOT touch backend, aggregator, or routing-core files. UI-only changes under `packages/console/src/panels/`.

---

### Task 1: `filterRows` pure filter

**Files:**
- Modify: `packages/console/src/panels/Insights/data.ts`
- Test: `packages/console/src/panels/Insights/data.test.ts`

**Interfaces:**
- Consumes: `AggIngredient` from `../../api/routes.js`; `prettifyId` from `./data.js`.
- Produces: `filterRows(rows: AggIngredient[], query: string): RankedRow[]` where `RankedRow = { row: AggIngredient; rank: number }`. `rank` is the 1-based index of `row` in the **original** `rows`. Blank/whitespace `query` returns every row with its rank. Matching is case-insensitive substring over the row's prettified `name`, `scope`, and raw `id`.

- [ ] **Step 1: Write the failing test**

Append to `packages/console/src/panels/Insights/data.test.ts`:

```ts
import { filterRows } from "./data.js";

describe("filterRows", () => {
  const rows = [
    { id: "skill:superpowers/brainstorming", kind: "skill", producers: 80, verifiedProducers: 40, invocations: 200, sessions: 90 },
    { id: "npx:@modelcontextprotocol/server-github", kind: "mcp", producers: 30, verifiedProducers: 9, invocations: 50, sessions: 25 },
    { id: "claude-opus-4-8", kind: "model", producers: 12, verifiedProducers: 3, invocations: 18, sessions: 10 },
  ];

  it("returns all rows with 1-based original ranks when the query is blank", () => {
    expect(filterRows(rows, "   ")).toEqual([
      { row: rows[0], rank: 1 }, { row: rows[1], rank: 2 }, { row: rows[2], rank: 3 },
    ]);
  });
  it("matches on the prettified name, case-insensitively", () => {
    expect(filterRows(rows, "BRAINSTORM")).toEqual([{ row: rows[0], rank: 1 }]);
  });
  it("matches on the scope", () => {
    expect(filterRows(rows, "superpowers")).toEqual([{ row: rows[0], rank: 1 }]);
  });
  it("matches on the raw id and preserves original rank", () => {
    expect(filterRows(rows, "opus")).toEqual([{ row: rows[2], rank: 3 }]);
  });
  it("returns empty when nothing matches", () => {
    expect(filterRows(rows, "zzz")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/console && pnpm test src/panels/Insights/data.test.ts`
Expected: FAIL — `filterRows` is not exported from `./data.js`.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/console/src/panels/Insights/data.ts` (the file already imports nothing it needs; `prettifyId` is defined above in the same file — reuse it directly):

```ts
import type { AggIngredient } from "../../api/routes.js";

export interface RankedRow { row: AggIngredient; rank: number }

/** Filter the leaderboard by a case-insensitive substring over name/scope/raw id.
 *  Rank is the row's 1-based position in the full (unfiltered) list, so ranks stay honest. */
export function filterRows(rows: AggIngredient[], query: string): RankedRow[] {
  const q = query.trim().toLowerCase();
  const ranked = rows.map((row, i) => ({ row, rank: i + 1 }));
  if (q === "") return ranked;
  return ranked.filter(({ row }) => {
    const p = prettifyId(row.id, row.kind);
    return (
      p.name.toLowerCase().includes(q) ||
      (p.scope?.toLowerCase().includes(q) ?? false) ||
      row.id.toLowerCase().includes(q)
    );
  });
}
```

> Note: if `import type { AggIngredient }` already exists at the top of `data.ts`, do not duplicate it — add the import only if absent. `prettifyId` is in the same module, so call it directly (no import).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/console && pnpm test src/panels/Insights/data.test.ts`
Expected: PASS (all `filterRows` cases plus the pre-existing `data.test.ts` cases).

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/panels/Insights/data.ts packages/console/src/panels/Insights/data.test.ts
git commit -m "feat(insights): filterRows — ranked, case-insensitive leaderboard filter"
```

---

### Task 2: Leaderboard search box

**Files:**
- Modify: `packages/console/src/panels/Insights/Leaderboard.tsx`
- Modify: `packages/console/src/panels/Insights/index.tsx`
- Modify: `packages/console/src/shell/theme.css`
- Test: `packages/console/src/panels/Insights/Leaderboard.test.tsx`

**Interfaces:**
- Consumes: `filterRows`, `RankedRow` from `./data.js` (Task 1).
- Produces: `Leaderboard` now also accepts `search: string` and `onSearch: (q: string) => void` props. `index.tsx` owns a `search` state string and passes it down.

- [ ] **Step 1: Write the failing test**

Replace the body of `packages/console/src/panels/Insights/Leaderboard.test.tsx` `describe` with the existing cases PLUS these (keep the three existing `it` blocks, add the new ones; the existing render calls must add the two new props `search="" onSearch={() => {}}`):

```ts
// Update the three existing render(...) calls to include: search="" onSearch={() => {}}

it("shows only matching rows and a no-match message when nothing matches", () => {
  const onSearch = vi.fn();
  const { rerender } = render(<Leaderboard rows={rows} kind="all" onKind={() => {}} selectedId={null} onSelect={() => {}} search="github" onSearch={onSearch} />);
  expect(screen.getByText("@mcp/github")).toBeTruthy();
  expect(screen.queryByText("brainstorming")).toBeNull();
  rerender(<Leaderboard rows={rows} kind="all" onKind={() => {}} selectedId={null} onSelect={() => {}} search="zzz" onSearch={onSearch} />);
  expect(screen.getByText(/no ingredients match/i)).toBeTruthy();
});

it("typing in the search box calls onSearch", () => {
  const onSearch = vi.fn();
  render(<Leaderboard rows={rows} kind="all" onKind={() => {}} selectedId={null} onSelect={() => {}} search="" onSearch={onSearch} />);
  fireEvent.change(screen.getByLabelText("search ingredients"), { target: { value: "brain" } });
  expect(onSearch).toHaveBeenCalledWith("brain");
});

it("preserves the original rank number when filtered", () => {
  render(<Leaderboard rows={rows} kind="all" onKind={() => {}} selectedId={null} onSelect={() => {}} search="github" onSearch={() => {}} />);
  expect(screen.getByText("2")).toBeTruthy(); // @mcp/github is row #2 in the full list
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/console && pnpm test src/panels/Insights/Leaderboard.test.tsx`
Expected: FAIL — `Leaderboard` does not accept `search`/`onSearch`, no search box, no filtering.

- [ ] **Step 3: Write minimal implementation**

Edit `packages/console/src/panels/Insights/Leaderboard.tsx`:

```tsx
import type { AggIngredient } from "../../api/routes.js";
import { prettifyId, kindLabel, verifiedShare, barWidths, filterRows } from "./data.js";

// Tools-only (product decision): Insights ranks shareable ingredients — skills + MCPs.
// "All" maps to no `kind` param, which the backend popularity() defaults to skill+mcp.
const KINDS: { value: string; label: string }[] = [
  { value: "all", label: "All" }, { value: "skill", label: "Skill" }, { value: "mcp", label: "MCP" },
];

export function Leaderboard({ rows, kind, onKind, selectedId, onSelect, search, onSearch }: {
  rows: AggIngredient[]; kind: string; onKind: (k: string) => void;
  selectedId: string | null; onSelect: (id: string) => void;
  search: string; onSearch: (q: string) => void;
}) {
  const widths = barWidths(rows.map((r) => r.producers)); // scale tied to the FULL list
  const visible = filterRows(rows, search);
  return (
    <div className="ins-board">
      <div className="ins-tabs">
        {KINDS.map((k) => (
          <button key={k.value} type="button"
            className={"ins-tab" + (k.value === kind ? " is-active" : "")}
            onClick={() => onKind(k.value)}>{k.label}</button>
        ))}
      </div>
      <input
        className="ins-search"
        type="text"
        aria-label="search ingredients"
        placeholder="filter the leaderboard…"
        value={search}
        onChange={(e) => onSearch(e.target.value)}
      />
      {rows.length === 0 && <div className="ins-empty">No ingredients above the k-anonymity floor yet.</div>}
      {rows.length > 0 && visible.length === 0 && <div className="ins-empty">No ingredients match “{search}”.</div>}
      <ol className="ins-rows">
        {visible.map(({ row: r, rank }) => {
          const p = prettifyId(r.id, r.kind);
          return (
            <li key={r.id}>
              <button type="button"
                className={"ins-row" + (r.id === selectedId ? " is-active" : "")}
                onClick={() => onSelect(r.id)}>
                <span className="ins-rank">{rank}</span>
                <span className="ins-name">{p.name}{p.scope && <span className="ins-scope">{p.scope}</span>}</span>
                <span className="ins-kind">{kindLabel(r.kind)}</span>
                <span className="ins-bar"><span className="ins-bar-fill" style={{ width: `${(widths[rank - 1] * 100).toFixed(0)}%` }} /></span>
                <span className="ins-counts">
                  {r.producers} producers
                  <span className="ins-verified" title="GitHub-bound, signature-verified producers"> · {r.verifiedProducers} verified ✓</span>
                </span>
                <span className="ins-vshare"><span className="ins-vshare-fill" style={{ width: `${(verifiedShare(r.producers, r.verifiedProducers) * 100).toFixed(0)}%` }} /></span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
```

Edit `packages/console/src/panels/Insights/index.tsx` — add the `search` state and pass it down. Add near the other `useState` calls:

```tsx
  const [search, setSearch] = useState("");
```

And update the `<Leaderboard .../>` render to include the two props:

```tsx
            : <Leaderboard rows={rows} kind={kind} onKind={setKind} selectedId={selectedId} onSelect={setSelectedId} search={search} onSearch={setSearch} />}
```

Append to `packages/console/src/shell/theme.css`:

```css
.ins-search {
  width: 100%;
  box-sizing: border-box;
  margin: 8px 0;
  padding: 6px 10px;
  font: inherit;
  color: inherit;
  background: var(--surface, rgba(255,255,255,0.04));
  border: 1px solid var(--border, rgba(255,255,255,0.12));
  border-radius: 6px;
}
.ins-search:focus { outline: none; border-color: var(--accent, #6ea8fe); }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/console && pnpm test src/panels/Insights/Leaderboard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run the panel test + typecheck to confirm no regressions**

Run: `cd packages/console && pnpm test src/panels/Insights && pnpm typecheck`
Expected: PASS (Insights.test.tsx still green; tsc clean).

- [ ] **Step 6: Commit**

```bash
git add packages/console/src/panels/Insights/Leaderboard.tsx packages/console/src/panels/Insights/index.tsx packages/console/src/panels/Insights/Leaderboard.test.tsx packages/console/src/shell/theme.css
git commit -m "feat(insights): leaderboard search box (client filter, ranks preserved)"
```

---

### Task 3: Cross-panel intent store

**Files:**
- Create: `packages/console/src/panels/GetGems/intent.ts`
- Test: `packages/console/src/panels/GetGems/intent.test.ts`

**Interfaces:**
- Produces: `setPendingQuery(q: string): void` and `takePendingQuery(): string | null` (returns the pending query and clears it; one-shot).

- [ ] **Step 1: Write the failing test**

Create `packages/console/src/panels/GetGems/intent.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { setPendingQuery, takePendingQuery } from "./intent.js";

afterEach(() => { takePendingQuery(); }); // drain between tests

describe("cross-panel intent", () => {
  it("returns null when nothing is pending", () => {
    expect(takePendingQuery()).toBeNull();
  });
  it("round-trips a pending query and clears it (one-shot)", () => {
    setPendingQuery("brainstorming");
    expect(takePendingQuery()).toBe("brainstorming");
    expect(takePendingQuery()).toBeNull();
  });
  it("keeps only the most recent pending query", () => {
    setPendingQuery("a");
    setPendingQuery("b");
    expect(takePendingQuery()).toBe("b");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/console && pnpm test src/panels/GetGems/intent.test.ts`
Expected: FAIL — module `./intent.js` not found.

- [ ] **Step 3: Write minimal implementation**

Create `packages/console/src/panels/GetGems/intent.ts`:

```ts
// Cross-panel deep-link intent. The console's hash router matches routes by exact
// equality (Shell.tsx: `p.route === hash`), so query suffixes like `#/get-gems?q=x`
// would not resolve. Instead we hand the pending search to Get Gems through this
// module-level holder and navigate to the clean `#/get-gems`. One-shot: taking it clears it.
let pending: string | null = null;

export function setPendingQuery(q: string): void { pending = q; }

export function takePendingQuery(): string | null {
  const v = pending;
  pending = null;
  return v;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/console && pnpm test src/panels/GetGems/intent.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/panels/GetGems/intent.ts packages/console/src/panels/GetGems/intent.test.ts
git commit -m "feat(getgems): one-shot cross-panel intent store"
```

---

### Task 4: "Find Gems using this" action on Insights detail

**Files:**
- Modify: `packages/console/src/panels/Insights/Detail.tsx`
- Modify: `packages/console/src/shell/theme.css`
- Test: `packages/console/src/panels/Insights/Detail.test.tsx`

**Interfaces:**
- Consumes: `setPendingQuery` from `../GetGems/intent.js` (Task 3).

- [ ] **Step 1: Write the failing test**

Append to `packages/console/src/panels/Insights/Detail.test.tsx` (keep existing imports/cases; add `vi` and the new case). The test stubs fetch so the detail renders, clicks the action, and asserts the intent was set and the hash changed:

```ts
import { takePendingQuery } from "../GetGems/intent.js";

it("deep-links to Get Gems with the ingredient name as the pending query", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/co-occurrence")) return res([]);
    if (url.includes("/adoption")) return res([]);
    throw new Error("unexpected " + url);
  }));
  window.location.hash = "";
  render(<Detail id="skill:superpowers/brainstorming" apiBase="" />);
  fireEvent.click(await screen.findByRole("button", { name: /find gems using this/i }));
  expect(window.location.hash).toBe("#/get-gems");
  expect(takePendingQuery()).toBe("brainstorming");
});
```

> If `Detail.test.tsx` lacks a `res` helper / `vi` import, add them matching the `Insights.test.tsx` pattern (`const res = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;` and `import { ..., vi } from "vitest"`).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/console && pnpm test src/panels/Insights/Detail.test.tsx`
Expected: FAIL — no "Find Gems using this" button.

- [ ] **Step 3: Write minimal implementation**

In `packages/console/src/panels/Insights/Detail.tsx`, add the import:

```tsx
import { setPendingQuery } from "../GetGems/intent.js";
```

Then inside the `ins-detail-head` block, after the name/scope spans, add the action button (it uses the already-computed `head`):

```tsx
      <div className="ins-detail-head">
        <span className="ins-detail-name">{head.name}</span>
        {head.scope && <span className="ins-scope">{head.scope}</span>}
        <button
          type="button"
          className="ins-find-gems"
          onClick={() => { setPendingQuery(head.name); window.location.hash = "#/get-gems"; }}
        >
          Find Gems using this →
        </button>
      </div>
```

Append to `packages/console/src/shell/theme.css`:

```css
.ins-find-gems {
  margin-left: auto;
  font: inherit;
  font-size: 0.85em;
  color: var(--accent, #6ea8fe);
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
}
.ins-find-gems:hover { text-decoration: underline; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/console && pnpm test src/panels/Insights/Detail.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/panels/Insights/Detail.tsx packages/console/src/panels/Insights/Detail.test.tsx packages/console/src/shell/theme.css
git commit -m "feat(insights): 'Find Gems using this' deep-link to Get Gems"
```

---

### Task 5: Get Gems consumes the pending query

**Files:**
- Modify: `packages/console/src/panels/GetGems/index.tsx`
- Test: `packages/console/src/panels/GetGems/GetGems.test.tsx`

**Interfaces:**
- Consumes: `takePendingQuery` from `./intent.js` (Task 3).
- Internal change: `search` gains an optional `term?: string` parameter so the intent path can search without waiting for the `q` state to settle. Existing callers (button onClick, Enter key) call `search()` with no argument and are unchanged in behavior.

- [ ] **Step 1: Write the failing test**

Append to `packages/console/src/panels/GetGems/GetGems.test.tsx`:

```ts
import { setPendingQuery } from "./intent.js";

it("auto-runs a search from a pending cross-panel query", async () => {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/api/registry/ready")) return res({ ready: true });
    if (u.includes("/api/registry/search")) {
      calls.push(u);
      return res({ results: [{ key: "acme/brainstorming-kit", latest: "1.0.0", score: 1, description: "kit", tags: [] }] });
    }
    throw new Error(`unexpected ${u}`);
  }));
  setPendingQuery("brainstorming");
  render(<GetGems apiBase="" />);
  expect(await screen.findByText("acme/brainstorming-kit")).toBeTruthy();
  expect((screen.getByLabelText("search registry") as HTMLInputElement).value).toBe("brainstorming");
  expect(calls.some((u) => u.includes("brainstorming"))).toBe(true);
});

it("does not auto-search on a normal visit (no pending query)", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/api/registry/ready")) return res({ ready: true });
    if (u.includes("/api/registry/search")) throw new Error("should not search");
    throw new Error(`unexpected ${u}`);
  }));
  render(<GetGems apiBase="" />);
  expect(await screen.findByText("Search")).toBeTruthy();
  expect((screen.getByLabelText("search registry") as HTMLInputElement).value).toBe("");
});
```

> The search input's `aria-label` is `"search registry"` (already in `index.tsx`).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/console && pnpm test src/panels/GetGems/GetGems.test.tsx`
Expected: FAIL — the first new test fails (no auto-search; input stays empty).

- [ ] **Step 3: Write minimal implementation**

Edit `packages/console/src/panels/GetGems/index.tsx`:

Add the import:

```tsx
import { takePendingQuery } from "./intent.js";
```

Make `search` accept an optional explicit term (replace the existing `const search = async () => {`):

```tsx
  const search = async (term?: string) => {
    setBusy(true);
    setError(null);
    try {
      const client = makeClient(apiBase);
      const query = (term ?? q).trim();
      const { results: r } = await registrySearchRoute.call(client, { query: { q: query || undefined } });
      setResults(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
```

Capture the pending query once at mount, and run it after the registry reports ready. Add, after the existing `useState` declarations:

```tsx
  const [pending] = useState<string | null>(() => takePendingQuery()); // one-shot, captured at mount
```

Add a new effect after the existing ready-check effect:

```tsx
  useEffect(() => {
    if (ready && pending) { setQ(pending); void search(pending); }
    // run only when `ready` flips; `pending` is captured once at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
```

> The existing `onKeyDown` Enter handler calls `void search()` and the Search button calls `search` (as `onClick={search}`). Both still type-check: `onClick={search}` passes a `MouseEvent` as `term`, which is now `string | undefined`-typed — change the button to `onClick={() => void search()}` to avoid passing the event object as a term.

Update the Search button line:

```tsx
        <button type="button" className="ledger-sort" disabled={busy} onClick={() => void search()}>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/console && pnpm test src/panels/GetGems/GetGems.test.tsx`
Expected: PASS (both new tests and the two pre-existing GetGems tests).

- [ ] **Step 5: Run the full console suite + typecheck**

Run: `cd packages/console && pnpm test && pnpm typecheck`
Expected: PASS — whole console test suite green, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add packages/console/src/panels/GetGems/index.tsx packages/console/src/panels/GetGems/GetGems.test.tsx
git commit -m "feat(getgems): consume cross-panel pending query and auto-search"
```

---

## Final verification

- [ ] **Run the complete console suite once more**

Run: `cd packages/console && pnpm test && pnpm typecheck`
Expected: all green, tsc clean.

- [ ] **Manual smoke (optional, if running the app):** open Insights → type in the new filter box (list narrows, ranks unchanged) → drill into a row → click "Find Gems using this →" → lands on Get Gems with the name pre-filled and results loaded.
