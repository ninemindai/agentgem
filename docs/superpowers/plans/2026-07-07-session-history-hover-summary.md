# Session History Hover Summary + Click-to-Open-Transcript — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the console History ledger, reveal a per-session activity skeleton on hover/focus and make a row click open that session's transcript directly, removing the inline expand.

**Architecture:** The raw `SessionStat[]` the History page already fetches carries per-session `tools`/`skills`/`subagents` count maps. The page builds an in-memory lookup from that data and passes it to the table; a pure presentational popover formats the counts. No backend, no new endpoint, no per-hover fetch. The token/timestamp/branch detail the old expand showed relocates into the existing `TranscriptViewer` header.

**Tech Stack:** React (function components + hooks), TypeScript, Vitest + `@testing-library/react`, jsdom.

## Global Constraints

- **Worktree:** all work happens in `/Users/rfeng/Projects/ninemind/agentgem-session-history` on branch `feat/session-history-hover-summary` (already created off `origin/main`).
- **Dependencies:** add none. Use only React and the existing `obs-*`/theme CSS variables.
- **Styling:** popover positioning is inline styles using existing CSS variables (`--raised`, `--line`, `--radius`, `--shadow-md`, `--ink-soft`, `--font-ui`) so it is theme-aware without editing `theme.css`.
- **Surgical:** do not touch sorting, the flame indicator, the N-of-M hint, `parseSelection`, `TranscriptDiff`, or the transcript route. Remove imports your change orphans (e.g. `fmtTime`, `React`).
- **Tests are not in CI** for `@agentgem/console`; run `pnpm test` **and** `pnpm typecheck` locally in `packages/console` — they are separate gates.
- **Commit identity / trailer:** commits are `Raymond Feng <raymond@ninemind.ai>`; end each commit message with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

### Setup (once, before Task 1)

A fresh worktree has no `node_modules`. From the worktree root:

Run: `cd /Users/rfeng/Projects/ninemind/agentgem-session-history && pnpm install`
Expected: install completes; `node_modules/.bin/vitest` now exists.

---

## File structure

- **Create** `packages/console/src/panels/Sessions/SessionSummaryPopover.tsx` — the `SessionActivity` type, the pure `formatActivity()` formatter, and the presentational `SessionSummaryPopover` component. One responsibility: turn counts into a formatted hover node.
- **Create** `packages/console/src/panels/Sessions/SessionSummaryPopover.test.tsx` — unit tests for the formatter + component.
- **Modify** `packages/console/src/panels/Sessions/SessionsTable.tsx` — drop the caret column, `openId` state, and the expanded detail row; add row-click/keyboard transcript navigation and hover/focus popover.
- **Modify** `packages/console/src/panels/Sessions/SessionsTable.test.tsx` — replace the expand-based tests with click-opens-transcript, keyboard, no-expand, hover/focus popover, and empty-fallback tests.
- **Modify** `packages/console/src/panels/Sessions/index.tsx` — build the `agent:sessionId → SessionActivity` lookup from raw `stats` and pass it to `SessionsTable`.
- **Modify** `packages/console/src/panels/Observe/TranscriptViewer.tsx` — surface the relocated token in/out/cache, absolute start→end, and branch in the `tv-head` meta line.

---

### Task 1: Activity formatter + popover component

**Files:**
- Create: `packages/console/src/panels/Sessions/SessionSummaryPopover.tsx`
- Test: `packages/console/src/panels/Sessions/SessionSummaryPopover.test.tsx`

**Interfaces:**
- Produces:
  - `interface SessionActivity { tools: Record<string, number>; skills: Record<string, number>; subagents: Record<string, number> }`
  - `formatActivity(a: SessionActivity): string[]` — top-5 tools by count desc (tie-break name asc) as `Name×N`, then distinct skill/subagent counts (`"1 skill"`, `"2 subagents"`); `[]` when all maps are empty.
  - `SessionSummaryPopover({ activity }: { activity: SessionActivity })` — renders `role="tooltip"`; joins parts with `" · "`, or the muted fallback `No recorded tool activity` when `formatActivity` returns `[]`.

- [ ] **Step 1: Write the failing test**

Create `packages/console/src/panels/Sessions/SessionSummaryPopover.test.tsx`:

```tsx
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { SessionSummaryPopover, formatActivity } from "./SessionSummaryPopover.js";

afterEach(() => cleanup());

describe("formatActivity", () => {
  it("orders tools by count desc then name asc, capping at 5", () => {
    const parts = formatActivity({
      tools: { Edit: 20, Bash: 8, Read: 20, Grep: 1, Write: 3, Glob: 2, Task: 9 },
      skills: {}, subagents: {},
    });
    // Edit and Read tie at 20 → name asc puts Edit first; only the top 5 survive.
    expect(parts).toEqual(["Edit×20", "Read×20", "Task×9", "Bash×8", "Write×3"]);
  });

  it("appends distinct skill/subagent counts with singular/plural", () => {
    expect(formatActivity({ tools: {}, skills: { a: 3 }, subagents: { x: 1, y: 2 } }))
      .toEqual(["1 skill", "2 subagents"]);
  });

  it("returns [] when nothing was recorded", () => {
    expect(formatActivity({ tools: {}, skills: {}, subagents: {} })).toEqual([]);
  });
});

describe("SessionSummaryPopover", () => {
  it("renders the formatted skeleton", () => {
    render(<SessionSummaryPopover activity={{ tools: { Edit: 2 }, skills: { s: 1 }, subagents: {} }} />);
    expect(screen.getByRole("tooltip").textContent).toContain("Edit×2 · 1 skill");
  });

  it("shows a fallback when there is no recorded activity", () => {
    render(<SessionSummaryPopover activity={{ tools: {}, skills: {}, subagents: {} }} />);
    expect(screen.getByText("No recorded tool activity")).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/console && pnpm test -- SessionSummaryPopover`
Expected: FAIL — cannot resolve `./SessionSummaryPopover.js` (module does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `packages/console/src/panels/Sessions/SessionSummaryPopover.tsx`:

```tsx
import type { CSSProperties } from "react";

export interface SessionActivity {
  tools: Record<string, number>;
  skills: Record<string, number>;
  subagents: Record<string, number>;
}

/** Deterministic one-line activity skeleton for a session's hover summary: the
 *  top-5 tools by invocation count (tie-break name asc) as `Name×N`, then the
 *  DISTINCT skill and subagent counts. All-empty maps → []. Pure; no fetching. */
export function formatActivity(a: SessionActivity): string[] {
  const parts = Object.entries(a.tools)
    .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
    .slice(0, 5)
    .map(([name, n]) => `${name}×${n}`);
  const nSkills = Object.keys(a.skills).length;
  if (nSkills > 0) parts.push(`${nSkills} skill${nSkills === 1 ? "" : "s"}`);
  const nSubs = Object.keys(a.subagents).length;
  if (nSubs > 0) parts.push(`${nSubs} subagent${nSubs === 1 ? "" : "s"}`);
  return parts;
}

// Anchored under the row's project cell (which is position:relative). Themed via
// existing CSS variables so it works in both light and dark without a theme.css edit.
const POP_STYLE: CSSProperties = {
  position: "absolute", top: "100%", left: 12, marginTop: 4, zIndex: 20,
  maxWidth: 460, whiteSpace: "normal",
  background: "var(--raised)", border: "1px solid var(--line)",
  borderRadius: "var(--radius)", boxShadow: "var(--shadow-md)",
  padding: "6px 10px", font: "11.5px/1.5 var(--font-ui)", color: "var(--ink-soft)",
};

/** Hover/focus popover showing a session's activity skeleton. */
export function SessionSummaryPopover({ activity }: { activity: SessionActivity }) {
  const parts = formatActivity(activity);
  return (
    <div className="obs-summary-pop" role="tooltip" style={POP_STYLE}>
      {parts.length === 0
        ? <span className="obs-muted">No recorded tool activity</span>
        : parts.join(" · ")}
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/console && pnpm test -- SessionSummaryPopover`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/rfeng/Projects/ninemind/agentgem-session-history
git add packages/console/src/panels/Sessions/SessionSummaryPopover.tsx packages/console/src/panels/Sessions/SessionSummaryPopover.test.tsx
git commit -m "feat(console): SessionSummaryPopover — deterministic per-session activity skeleton

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Rewire SessionsTable — hover summary, click opens transcript, drop expand

**Files:**
- Modify: `packages/console/src/panels/Sessions/SessionsTable.tsx`
- Test: `packages/console/src/panels/Sessions/SessionsTable.test.tsx`

**Interfaces:**
- Consumes: `SessionActivity`, `SessionSummaryPopover` from Task 1.
- Produces: `SessionsTable({ data, activity }: { data: ObservePayload; activity: Map<string, SessionActivity> })` — `activity` keyed by `` `${agent}:${sessionId}` ``. A row with no entry (or empty maps) still shows the popover with the fallback text.

- [ ] **Step 1: Rewrite the test file (failing)**

Replace the entire contents of `packages/console/src/panels/Sessions/SessionsTable.test.tsx` with:

```tsx
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { SessionsTable } from "./SessionsTable.js";
import type { SessionActivity } from "./SessionSummaryPopover.js";
import type { ObservePayload } from "../../api/routes.js";

afterEach(() => { cleanup(); window.location.hash = ""; });

const payload: ObservePayload = {
  pulse: { sessions: 2, msgs: 12, tokens: 1_200_000, activeMs: 2.1 * 3_600_000 },
  daily: [{ date: "2026-06-28", sessions: 2, msgs: 12, tokensIn: 800_000, tokensOut: 300_000, tokensCache: 100_000 }],
  sessions: [{
    agent: "claude", sessionId: "s1", project: "agentgem", model: "claude-opus-4-8",
    startMs: 1_750_000_000_000, endMs: 1_750_010_000_000, durationMs: 10_000_000,
    msgs: 8, tokens: 900_000,
    tokensIn: 700_000, tokensOut: 150_000, tokensCache: 50_000, gitBranch: "main",
  }],
  models: [{ model: "claude-opus-4-8", agent: "claude", sessions: 2, tokens: 1_200_000 }],
  byTool: [], bySkill: [], bySubagent: [], usageDaily: [],
  facets: { agents: ["claude"], projects: ["agentgem"], models: ["claude-opus-4-8"] },
  range: "7d",
};

const activity = new Map<string, SessionActivity>([
  ["claude:s1", { tools: { Edit: 4, Bash: 2 }, skills: { insights: 1 }, subagents: {} }],
]);
const emptyActivity = new Map<string, SessionActivity>();

const rowOf = (c: HTMLElement) => c.querySelector('tr[role="button"]') as HTMLElement;

describe("SessionsTable", () => {
  it("clicking a session row opens its transcript", () => {
    window.location.hash = "";
    const { container } = render(<SessionsTable data={payload} activity={activity} />);
    fireEvent.click(rowOf(container));
    expect(window.location.hash).toBe("#/sessions/claude/s1");
  });

  it("Enter and Space on a row open its transcript", () => {
    const { container } = render(<SessionsTable data={payload} activity={activity} />);
    const row = rowOf(container);
    window.location.hash = "";
    fireEvent.keyDown(row, { key: "Enter" });
    expect(window.location.hash).toBe("#/sessions/claude/s1");
    window.location.hash = "";
    fireEvent.keyDown(row, { key: " " });
    expect(window.location.hash).toBe("#/sessions/claude/s1");
  });

  it("no longer renders an inline expand detail row", () => {
    const { container } = render(<SessionsTable data={payload} activity={activity} />);
    fireEvent.click(rowOf(container));
    expect(container.querySelector(".obs-detail")).toBeNull();
    expect(screen.queryByText(/Open transcript/)).toBeNull();
  });

  it("hovering a row shows its activity skeleton", () => {
    const { container } = render(<SessionsTable data={payload} activity={activity} />);
    const row = rowOf(container);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.mouseEnter(row);
    expect(screen.getByRole("tooltip").textContent).toContain("Edit×4 · Bash×2 · 1 skill");
    fireEvent.mouseLeave(row);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("focus also reveals the popover", () => {
    const { container } = render(<SessionsTable data={payload} activity={activity} />);
    fireEvent.focus(rowOf(container));
    expect(screen.getByRole("tooltip")).toBeDefined();
  });

  it("shows a fallback when the row has no recorded activity", () => {
    const { container } = render(<SessionsTable data={payload} activity={emptyActivity} />);
    fireEvent.mouseEnter(rowOf(container));
    expect(screen.getByText("No recorded tool activity")).toBeDefined();
  });

  it("renders a flame badge for the hottest session", () => {
    const { container } = render(<SessionsTable data={payload} activity={activity} />);
    const flameBadge = container.querySelector(".obs-flame");
    expect(flameBadge).not.toBeNull();
    expect(flameBadge!.textContent).toContain("🔥");
  });

  it("shows N-of-M hint when pulse.sessions > visible rows", () => {
    render(<SessionsTable data={{ ...payload, pulse: { ...payload.pulse, sessions: 500 } }} activity={activity} />);
    expect(screen.getByText(/Showing 1 of 500 sessions/)).toBeDefined();
  });

  it("does not show N-of-M hint when pulse.sessions equals visible rows", () => {
    render(<SessionsTable data={{ ...payload, pulse: { ...payload.pulse, sessions: 1 } }} activity={activity} />);
    expect(screen.queryByText(/Showing \d+ of \d+ sessions/)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/console && pnpm test -- SessionsTable`
Expected: FAIL — the current table still renders the expand (`clicking … opens its transcript` fails because click toggles `openId` instead of setting the hash) and has no `activity` prop / popover.

- [ ] **Step 3: Rewrite the implementation**

Replace the entire contents of `packages/console/src/panels/Sessions/SessionsTable.tsx` with:

```tsx
import { useState } from "react";
import type { ObservePayload } from "../../api/routes.js";
import { fmtTokens, fmtDuration, flameLevel, utcDay } from "../Observe/data.js";
import { SessionSummaryPopover, type SessionActivity } from "./SessionSummaryPopover.js";

type SortKey = "tokens" | "msgs" | "durationMs" | "endMs";

const EMPTY_ACTIVITY: SessionActivity = { tools: {}, skills: {}, subagents: {} };

/** The session ledger: sortable table of runs. Hover or focus a row for its
 *  activity skeleton; click (or Enter/Space) a row to open that session's
 *  transcript (#/sessions/<agent>/<sessionId>). */
export function SessionsTable({ data, activity }: {
  data: ObservePayload;
  activity: Map<string, SessionActivity>;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "endMs", dir: "desc" });
  const [hoverId, setHoverId] = useState<string | null>(null);

  function toggleSort(key: SortKey) {
    setSort(prev => prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" });
  }

  const rows = [...data.sessions].sort((a, b) => {
    const av = a[sort.key], bv = b[sort.key];
    return sort.dir === "asc" ? av - bv : bv - av;
  });
  const maxTok = Math.max(0, ...rows.map(r => r.tokens));

  const open = (agent: string, sessionId: string) => {
    window.location.hash = `#/sessions/${agent}/${encodeURIComponent(sessionId)}`;
  };

  return (
    <div className="obs-table-wrap">
      {data.pulse.sessions > rows.length && (
        <p className="obs-muted obs-table-hint">
          Showing {rows.length} of {data.pulse.sessions} sessions (most recent)
        </p>
      )}
      <table className="obs-table">
        <thead>
          <tr>
            <th>project</th>
            <th>agent</th>
            <th>model</th>
            <SortTh label="dur" col="durationMs" sort={sort} onSort={toggleSort} />
            <SortTh label="msgs" col="msgs" sort={sort} onSort={toggleSort} />
            <SortTh label="tokens" col="tokens" sort={sort} onSort={toggleSort} />
            <SortTh label="recency" col="endMs" sort={sort} onSort={toggleSort} />
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const rowId = s.agent + ":" + s.sessionId;
            const flames = flameLevel(s.tokens, maxTok);
            return (
              <tr
                key={rowId}
                role="button"
                tabIndex={0}
                style={{ cursor: "pointer" }}
                onClick={() => open(s.agent, s.sessionId)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(s.agent, s.sessionId); }
                }}
                onMouseEnter={() => setHoverId(rowId)}
                onMouseLeave={() => setHoverId((h) => (h === rowId ? null : h))}
                onFocus={() => setHoverId(rowId)}
                onBlur={() => setHoverId((h) => (h === rowId ? null : h))}
              >
                <td style={{ position: "relative" }}>
                  {s.project ?? "—"}
                  {flames > 0 && <span className="obs-flame" aria-hidden="true">{"🔥".repeat(flames)}</span>}
                  {hoverId === rowId && (
                    <SessionSummaryPopover activity={activity.get(rowId) ?? EMPTY_ACTIVITY} />
                  )}
                </td>
                <td><span className="obs-chip">{s.agent}</span></td>
                <td className="obs-muted">{s.model ?? "—"}</td>
                <td>{fmtDuration(s.durationMs)}</td>
                <td>{s.msgs}</td>
                <td>{fmtTokens(s.tokens)}</td>
                <td className="obs-muted">{s.endMs ? utcDay(s.endMs) : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SortTh({ label, col, sort, onSort }: {
  label: string; col: SortKey;
  sort: { key: SortKey; dir: "asc" | "desc" };
  onSort: (k: SortKey) => void;
}) {
  const active = sort.key === col;
  return (
    <th aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" className={"obs-sort-btn" + (active ? " is-active" : "")} onClick={() => onSort(col)}>
        {label}{active ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
      </button>
    </th>
  );
}
```

Note the intentional removals versus the old file: the `React`/`fmtTime` imports, the `COL_COUNT` constant, the `openId` state, the caret `<th>`/`<td>`, the `React.Fragment` wrapper, and the `.obs-detail` expanded row with its "Open transcript →" button.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/console && pnpm test -- SessionsTable`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/rfeng/Projects/ninemind/agentgem-session-history
git add packages/console/src/panels/Sessions/SessionsTable.tsx packages/console/src/panels/Sessions/SessionsTable.test.tsx
git commit -m "feat(console): History rows hover a summary and click to open the transcript

Row click (or Enter/Space) now opens the transcript directly; hover/focus
reveals the deterministic activity skeleton. The inline expand is removed.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Thread the activity lookup from the History page

**Files:**
- Modify: `packages/console/src/panels/Sessions/index.tsx`

**Interfaces:**
- Consumes: `SessionsTable({ data, activity })` (Task 2), `SessionActivity` (Task 1), the existing `useObserveData().stats: SessionStat[]`.
- Produces: nothing new — this is the integration point that makes the hover live.

This task has no unit test (the page composes fetch + aggregation; there is no existing `index.test.tsx` and adding a fetch harness is out of scope). It is gated by `pnpm typecheck` and by the manual verification in Task 5.

- [ ] **Step 1: Add the import**

In `packages/console/src/panels/Sessions/index.tsx`, immediately after the existing line:

```tsx
import { SessionsTable } from "./SessionsTable.js";
```

add:

```tsx
import type { SessionActivity } from "./SessionSummaryPopover.js";
```

- [ ] **Step 2: Build the lookup**

In `index.tsx`, directly after the existing `const data = useMemo(...)` block (the one that calls `aggregateObserve`), add:

```tsx
  // Per-session activity counts for the row hover popover, keyed agent:sessionId.
  // Sourced from the raw stats already fetched — no extra request.
  const activity = useMemo(() => {
    const m = new Map<string, SessionActivity>();
    for (const s of stats ?? []) {
      m.set(`${s.agent}:${s.sessionId}`, {
        tools: s.tools ?? {}, skills: s.skills ?? {}, subagents: s.subagents ?? {},
      });
    }
    return m;
  }, [stats]);
```

- [ ] **Step 3: Pass it to the table**

In `index.tsx`, change:

```tsx
      <SessionsTable data={data} />
```

to:

```tsx
      <SessionsTable data={data} activity={activity} />
```

- [ ] **Step 4: Typecheck**

Run: `cd packages/console && pnpm typecheck`
Expected: no errors from `panels/Sessions/*`. (Pre-existing errors elsewhere in the package, if any, are out of scope — confirm none are newly introduced in `Sessions/`.)

- [ ] **Step 5: Commit**

```bash
cd /Users/rfeng/Projects/ninemind/agentgem-session-history
git add packages/console/src/panels/Sessions/index.tsx
git commit -m "feat(console): feed per-session activity counts to the History table

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Relocate the token/timestamp/branch detail into the transcript header

**Files:**
- Modify: `packages/console/src/panels/Observe/TranscriptViewer.tsx`

**Interfaces:**
- Consumes: `view.meta` (type `ObserveRawSchema.shape.sessions.element`) which carries `model`, `startMs`, `endMs`, `msgs`, `tokensIn`, `tokensOut`, `tokensCache`, `gitBranch`; and `fmtTime`/`fmtTokens`/`fmtDuration` from `./data.js`.
- Produces: nothing consumed downstream — a display-only header enrichment.

No unit test (this component fetches its data over the network; there is no `TranscriptViewer.test.tsx`). Gated by `pnpm typecheck` and the manual verification in Task 5.

- [ ] **Step 1: Import `fmtTime`**

In `packages/console/src/panels/Observe/TranscriptViewer.tsx`, change:

```tsx
import { fmtTokens, fmtDuration } from "./data.js";
```

to:

```tsx
import { fmtTokens, fmtDuration, fmtTime } from "./data.js";
```

- [ ] **Step 2: Enrich the header meta line**

In the same file, replace the `tv-meta` span:

```tsx
            <span className="obs-muted tv-meta">
              {view.meta.model ?? "—"} · {fmtDuration(view.meta.endMs - view.meta.startMs)} · {view.meta.msgs} msgs ·{" "}
              {fmtTokens(view.meta.tokensIn + view.meta.tokensOut)} tokens
            </span>
```

with:

```tsx
            <span className="obs-muted tv-meta">
              {view.meta.model ?? "—"} · {fmtDuration(view.meta.endMs - view.meta.startMs)} · {view.meta.msgs} msgs ·{" "}
              {fmtTokens(view.meta.tokensIn + view.meta.tokensOut)} tokens{" "}
              (in {fmtTokens(view.meta.tokensIn)} · out {fmtTokens(view.meta.tokensOut)} · cache {fmtTokens(view.meta.tokensCache)}) ·{" "}
              {fmtTime(view.meta.startMs)} → {fmtTime(view.meta.endMs)} · branch {view.meta.gitBranch ?? "—"}
            </span>
```

- [ ] **Step 3: Typecheck**

Run: `cd packages/console && pnpm typecheck`
Expected: no new errors from `panels/Observe/TranscriptViewer.tsx`.

- [ ] **Step 4: Commit**

```bash
cd /Users/rfeng/Projects/ninemind/agentgem-session-history
git add packages/console/src/panels/Observe/TranscriptViewer.tsx
git commit -m "feat(console): show token in/out/cache, start→end and branch in transcript header

Relocates the detail the History expand used to carry, now that a History row
opens the transcript directly.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Full console test suite**

Run: `cd packages/console && pnpm test`
Expected: PASS — including the new `SessionSummaryPopover` and rewritten `SessionsTable` tests, with no regressions elsewhere in the package.

- [ ] **Step 2: Typecheck the whole package**

Run: `cd packages/console && pnpm typecheck`
Expected: no errors introduced by this change (compare against a pre-change baseline if the package already has unrelated errors).

- [ ] **Step 3: Manual smoke via the running app**

Use the `run` skill (or the project's console launch) to open the console, go to History (`#/sessions`), and confirm:
  - Hovering (and tab-focusing) a row shows the activity-skeleton popover; a row with no recorded tools shows `No recorded tool activity`.
  - Clicking a row (and Enter/Space on a focused row) opens that session's transcript.
  - The transcript header shows the token in/out/cache breakdown, absolute start→end, and branch.
  - No caret column and no inline expand remain.

- [ ] **Step 4: Confirm the branch is ahead of origin/main only**

Run: `cd /Users/rfeng/Projects/ninemind/agentgem-session-history && git fetch origin && git log --oneline origin/main..HEAD`
Expected: exactly the commits from Tasks 1–4 (plus the spec commit), each authored on top of `origin/main`.

---

## Self-review

**Spec coverage:**
- Hover/focus summary → Tasks 1–3. ✅
- Row click (and Enter/Space) opens transcript → Task 2. ✅
- Inline expand removed → Task 2 (impl) + Task 2 tests assert `.obs-detail` / "Open transcript" gone. ✅
- Data from already-loaded raw `stats`, no backend/fetch → Task 3 builds the map from `stats`. ✅
- Empty-counts / missing-entry fallback → Task 2 `EMPTY_ACTIVITY` + fallback test; Task 1 fallback render. ✅
- Relocate token/timestamp/branch into transcript header → Task 4. ✅
- Testing (`SessionsTable.test.tsx`, popover unit test, local `pnpm test` + `pnpm typecheck`) → Tasks 1, 2, 5. ✅

**Placeholder scan:** No TBD/TODO; every code step shows full code; every run step shows an exact command + expected result.

**Type consistency:** `SessionActivity` (`tools`/`skills`/`subagents: Record<string, number>`) is defined in Task 1 and consumed identically in Tasks 2 and 3. `activity: Map<string, SessionActivity>` keyed `agent:sessionId` is produced in Task 3 and consumed in Task 2 with the same key format (`s.agent + ":" + s.sessionId`). `formatActivity`/`SessionSummaryPopover` names match across tasks.
