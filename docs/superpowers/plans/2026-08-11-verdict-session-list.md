# Per-Session Verdict List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person record rubric verdicts at `project` and `all` scope by expanding a fired factor to reveal the sessions it fired in, each with its own controls.

**Architecture:** Console-only. Every field is already on `RubricReportView.perSession[]`. Existing per-row state is re-keyed from bare `factorId` to `(sessionId, factorId)`, then a new presentational `FactorSessionList` renders the expansion beneath each fired factor row.

**Tech Stack:** React 19, TypeScript (ESM, NodeNext), vitest + jsdom + `@testing-library/react`, hand-authored CSS.

**Spec:** `docs/superpowers/specs/2026-08-11-verdict-session-list-design.md`

## Global Constraints

- **Console tests run from SOURCE, not dist:** `pnpm --filter @agentgem/console test` and `pnpm --filter @agentgem/console typecheck`. (The ROOT suite is the opposite — it runs compiled JS and needs `pnpm exec tsc -b` first. This plan touches only the console, but run the root suite once in Task 4.)
- **Use `--filter`, never `--root`.**
- **Every new `rub-*` className needs a matching rule in `packages/console/src/shell/theme.css` in the same commit.** The console hand-authors all CSS; a class with no rule renders as raw browser defaults and ships as unstyled UI. Verify with grep before finishing, and confirm every `var(--…)` token you use exists in `theme.css`.
- **The NUL separator must be written as the six-character escape** (backslash, u, 0, 0, 0, 0) inside the string literal — never a literal NUL byte. A raw NUL makes the file binary-classified, so plain `grep` silently skips it and returns "no match" for text that is present. Verify every file you touch with: `grep -q . <file> && echo TEXT_OK || echo BINARY_BAD`. This has bitten this repo three times.
- **Never render a number that implies coverage it does not have.** The batch count and the report's 200-row cap are different truncations and must be stated separately (spec §4).
- Copyright header on every new file:
  ```ts
  // Copyright (c) 2026 NineMind, Inc.
  // SPDX-License-Identifier: MIT
  ```
- Commit with `git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit ...`
- Commit messages end with: `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `packages/console/src/panels/Rubrics/rubricStream.ts` | View types + client routes. Gains the verdict key helper, the shared label list, and the `PerSessionRow` alias — placed here (not in `index.tsx`) because `FactorSessionList` needs them and importing from `index.tsx` would create a cycle. | 1 |
| `packages/console/src/panels/Rubrics/index.tsx` | The panel. State re-keyed; `FactorRow` gains a toggle + slot; card computes fires-per-factor. | 1, 3 |
| `packages/console/src/panels/Rubrics/FactorSessionList.tsx` | **New.** Presentational: renders sorted rows, the batch, the footer. Computes nothing. | 2 |
| `packages/console/src/shell/theme.css` | Rules for the new `rub-fire-*` classes. | 2, 3 |

---

### Task 1: Re-key per-row state to (sessionId, factorId)

Pure refactor: no new UI, no visible behaviour change at session scope. It exists on its own because everything after it depends on the key change, and a reviewer can judge it in isolation.

Today `calls` and `failedIds` are keyed by bare `factorId` (`index.tsx:164,171`) and `record` closes over `callable` (`:173-174`). With many rows per factor, a `factorId` key would make one row's failure light up every sibling.

**Files:**
- Modify: `packages/console/src/panels/Rubrics/rubricStream.ts` (add three exports)
- Modify: `packages/console/src/panels/Rubrics/index.tsx:51-66` (move labels out), `:164-189` (state + `record`), `:238-249` (call site)
- Test: `packages/console/src/panels/Rubrics/__tests__/verdictControls.test.tsx` (extend)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces, all exported from `rubricStream.ts`: `verdictKeyOf(sessionId: string, factorId: string): string`; `VERDICT_LABELS: { value: VerdictValueView; label: string }[]`; `type PerSessionRow = NonNullable<RubricReportView["perSession"]>[number]`. And in `index.tsx`, `record` becomes `(sessionId: string, factorId: string, verdict: VerdictValueView, note?: string) => void`.

- [ ] **Step 1: Write the failing test**

Append to `packages/console/src/panels/Rubrics/__tests__/verdictControls.test.tsx`:

```tsx
describe("verdict key scoping", () => {
  it("builds a key from both the session and the factor", async () => {
    const { verdictKeyOf } = await import("../rubricStream.js");
    expect(verdictKeyOf("s1", "f1")).not.toBe(verdictKeyOf("s2", "f1"));
    expect(verdictKeyOf("s1", "f1")).toBe(verdictKeyOf("s1", "f1"));
    // Separator must be the escape, never a raw byte — a raw NUL makes the source
    // binary-classified and grep silently skips it.
    expect(verdictKeyOf("s1", "f1")).toContain("\u0000");
  });

  it("cannot be spoofed by ids that contain the separator", async () => {
    // A separator that can appear inside an id lets ("a", "b|c") collide with
    // ("a|b", "c"). NUL cannot occur in a sessionId or a kebab-case factor id, which
    // is why it is the separator — this test pins that property rather than assuming it.
    const { verdictKeyOf } = await import("../rubricStream.js");
    expect(verdictKeyOf("a", "b|c")).not.toBe(verdictKeyOf("a|b", "c"));
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
pnpm --filter @agentgem/console test -- verdictControls
```

Expected: FAIL — `verdictKeyOf` is not exported from `rubricStream.ts`.

- [ ] **Step 3: Add the shared exports to `rubricStream.ts`**

Append to `packages/console/src/panels/Rubrics/rubricStream.ts`:

```ts
/** One row of the report's per-session detail. */
export type PerSessionRow = NonNullable<RubricReportView["perSession"]>[number];

// Written as an escape, not a literal NUL byte, so the source stays greppable —
// a stray control byte makes grep classify the file as binary and skip it.
const VERDICT_KEY_SEP = "\u0000";

/**
 * The client-side key for one verdict. Both halves are required: the same factor now
 * appears on many rows, so a factorId-only key would let one row's failure or
 * optimistic value bleed onto every sibling.
 */
export function verdictKeyOf(sessionId: string, factorId: string): string {
  return `${sessionId}${VERDICT_KEY_SEP}${factorId}`;
}

// Order and canonical values mirror @agentgem/insight's VERDICT_VALUES
// (rubricVerdicts.ts: ["accepted", "wrong", "wontfix"]) — the console can't import
// that package's barrel. The Record forces every VerdictValueView member to have a
// label, and the exhaustiveness assertion forces the tuple to cover every member,
// so this list cannot silently drift from the server's canonical one.
const LABEL_BY_VALUE: Record<VerdictValueView, string> = {
  accepted: "Accepted", wrong: "Wrong", wontfix: "Won't fix",
};
const VERDICT_VALUE_ORDER = ["accepted", "wrong", "wontfix"] as const;
type _AssertOrderIsExhaustive = Exclude<VerdictValueView, (typeof VERDICT_VALUE_ORDER)[number]> extends never ? true : never;
const _assertOrderIsExhaustive: _AssertOrderIsExhaustive = true;
void _assertOrderIsExhaustive;

export const VERDICT_LABELS: { value: VerdictValueView; label: string }[] =
  VERDICT_VALUE_ORDER.map((value) => ({ value, label: LABEL_BY_VALUE[value] }));
```

Then DELETE lines 51-66 of `index.tsx` (the `LABEL_BY_VALUE` / `VERDICT_VALUE_ORDER` / assertion / `VERDICT_LABELS` block) and add `VERDICT_LABELS`, `verdictKeyOf`, and `type PerSessionRow` to the existing `./rubricStream.js` import at the top of the file. Do not add a second import statement.

- [ ] **Step 4: Re-key the state and `record` in `index.tsx`**

Replace `record` (`:173-189`) with:

```tsx
  const record = (sessionId: string, factorId: string, verdict: VerdictValueView, note?: string) => {
    if (!client) return;
    // Keyed on BOTH halves: the same factor now has a row per session, so a
    // factorId-only key would bleed one row's optimistic value onto its siblings.
    const key = verdictKeyOf(sessionId, factorId);
    const prev = calls[key];
    setCalls((c) => ({ ...c, [key]: verdict }));   // optimistic
    setFailedIds((s) => (s.has(key) ? new Set([...s].filter((k) => k !== key)) : s));
    const body: { sessionId: string; factorId: string; rubricId: string; verdict: VerdictValueView; note?: string } =
      { sessionId, factorId, rubricId: report.rubricId, verdict };
    if (note !== undefined) body.note = note;
    postRubricVerdict(client, body)
      // Calibration stays keyed by factor — it is a per-factor number, not per-row.
      .then((r) => setRates((m) => ({ ...m, [factorId]: r.calibration })))
      .catch(() => {
        // A dropped verdict is user input lost — roll back and say so rather than
        // leaving the button looking saved.
        setCalls((c) => { const n = { ...c }; if (prev) n[key] = prev; else delete n[key]; return n; });
        setFailedIds((s) => new Set(s).add(key));
      });
  };
```

Update the comment above `failedIds` (`:169-170`) to read:

```tsx
  // Keyed by `${sessionId}\u0000${factorId}`, not by factor alone — the same factor
  // has a row per session, and a factor-keyed flag would light up every sibling.
```

- [ ] **Step 5: Update the `FactorRow` call site**

Replace the `<FactorRow …>` props block (`:238-249`) with:

```tsx
        {report.factors.map((f) => {
          // Only session scope has a single unambiguous session for the aggregate row.
          const rowKey = callable ? verdictKeyOf(callable, f.id) : undefined;
          return (
            <FactorRow
              key={f.id}
              f={f}
              sessionId={callable}
              current={(rowKey ? calls[rowKey] : undefined) ?? stored?.[f.id]?.verdict}
              currentNote={stored?.[f.id]?.note}
              calibration={rates[f.id] ?? f.calibration}
              onRecord={client && callable ? (fid, v) => record(callable, fid, v) : undefined}
              onNote={client && callable ? (fid, v, note) => record(callable, fid, v, note) : undefined}
              failed={!!rowKey && failedIds.has(rowKey)}
            />
          );
        })}
```

`FactorRow`'s own props and body are unchanged in this task — it still takes `onRecord?: (factorId, verdict) => void`; the session is bound at the call site.

- [ ] **Step 6: Run the tests and verify they pass**

```bash
pnpm --filter @agentgem/console test -- verdictControls
pnpm --filter @agentgem/console test -- factorRow
pnpm --filter @agentgem/console typecheck
```

Expected: the two new key tests pass, and every pre-existing test in both files still passes unchanged — this task must not alter session-scope behaviour.

- [ ] **Step 7: Commit**

```bash
git add packages/console/src/panels/Rubrics/rubricStream.ts packages/console/src/panels/Rubrics/index.tsx packages/console/src/panels/Rubrics/__tests__/verdictControls.test.tsx
git commit -m "refactor(console): key verdict state by session and factor

A factor is about to have a row per session. Keyed by factor alone, one
row's failed write would light up every sibling and one row's optimistic
value would appear on all of them.

Moves the verdict label list and the new key helper into rubricStream.ts
so the coming list component can share them without importing index.tsx
and creating a cycle. No behaviour change at session scope.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The `FactorSessionList` component

Presentational only: it renders rows that arrive already filtered and already sorted, and computes nothing but its own batch window. Same split that keeps `HygieneLeaderboard.tsx` testable.

**Files:**
- Create: `packages/console/src/panels/Rubrics/FactorSessionList.tsx`
- Modify: `packages/console/src/shell/theme.css`
- Test: `packages/console/src/panels/Rubrics/__tests__/factorSessionList.test.tsx`

**Interfaces:**
- Consumes: `PerSessionRow`, `VERDICT_LABELS`, `VerdictValueView` from `rubricStream.ts` (Task 1).
- Produces: `FactorSessionList` with the props block shown in Step 3, and `BATCH_SIZE = 10`.

- [ ] **Step 1: Write the failing test**

Create `packages/console/src/panels/Rubrics/__tests__/factorSessionList.test.tsx`:

```tsx
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { FactorSessionList } from "../FactorSessionList.js";
import type { PerSessionRow } from "../rubricStream.js";

afterEach(cleanup);

const FACTOR = "retry-storm";

// n rows, each firing FACTOR `count` times, newest ids first so sorting is observable.
function rows(specs: { id: string; count: number }[]): PerSessionRow[] {
  return specs.map(({ id, count }) => ({
    sessionId: id,
    transcript: `/tmp/${id}.jsonl`,
    factors: [{ id: FACTOR, title: "Retry storm", advice: "a", severity: "warn" as const, count, sessions: 1 }],
  }));
}

const base = {
  factorId: FACTOR,
  summarySessions: 3,
  truncated: false,
  verdictFor: () => undefined,
  noteFor: () => undefined,
  onRecord: () => {},
  onNote: () => {},
  failedIds: new Set<string>(),
};

describe("FactorSessionList", () => {
  it("renders one row per firing session, worst-first", () => {
    render(<FactorSessionList {...base} rows={rows([{ id: "a", count: 1 }, { id: "b", count: 5 }, { id: "c", count: 3 }])} />);
    const labels = screen.getAllByTestId("rub-fire-row").map((n) => n.textContent ?? "");
    // The component must NOT sort — it renders what it is given, in order.
    expect(labels[0]).toContain("a.jsonl");
    expect(labels[1]).toContain("b.jsonl");
  });

  it("shows each row's own fire count", () => {
    render(<FactorSessionList {...base} rows={rows([{ id: "a", count: 5 }])} />);
    expect(screen.getByTestId("rub-fire-row").textContent).toContain("5×");
  });

  it("batches at 10 and reveals the next batch on Show more", () => {
    const many = rows(Array.from({ length: 25 }, (_, i) => ({ id: `s${i}`, count: 1 })));
    render(<FactorSessionList {...base} rows={many} summarySessions={25} />);
    expect(screen.getAllByTestId("rub-fire-row")).toHaveLength(10);
    fireEvent.click(screen.getByRole("button", { name: /show more/i }));
    expect(screen.getAllByTestId("rub-fire-row")).toHaveLength(20);
  });

  it("states the batch honestly and says nothing about a cap that did not bite", () => {
    render(<FactorSessionList {...base} rows={rows([{ id: "a", count: 1 }])} summarySessions={1} />);
    const footer = screen.getByTestId("rub-fire-footer").textContent ?? "";
    expect(footer).toContain("showing 1 of 1 available");
    expect(footer).not.toMatch(/cap/i);
  });

  it("names the report cap when fires are missing entirely", () => {
    // The summary says 40 sessions; only 3 rows survived the 200-row report cap.
    render(<FactorSessionList {...base} rows={rows([{ id: "a", count: 1 }, { id: "b", count: 1 }, { id: "c", count: 1 }])} summarySessions={40} truncated />);
    const footer = screen.getByTestId("rub-fire-footer").textContent ?? "";
    expect(footer).toContain("showing 3 of 3 available");
    expect(footer).toContain("37 more beyond this report's 200-session cap");
  });

  it("posts the row's OWN sessionId, never a neighbour's", () => {
    const onRecord = vi.fn();
    render(<FactorSessionList {...base} rows={rows([{ id: "a", count: 1 }, { id: "b", count: 1 }])} onRecord={onRecord} />);
    const second = screen.getAllByTestId("rub-fire-row")[1];
    fireEvent.click(within(second).getByRole("button", { name: /^wrong/i }));
    expect(onRecord).toHaveBeenCalledWith("b", FACTOR, "wrong");
  });

  it("marks only the row that failed", () => {
    render(<FactorSessionList {...base}
      rows={rows([{ id: "a", count: 1 }, { id: "b", count: 1 }])}
      failedIds={new Set([`b\u0000${FACTOR}`])} />);
    const [first, second] = screen.getAllByTestId("rub-fire-row");
    expect(first.textContent).not.toMatch(/not saved/i);
    expect(second.textContent).toMatch(/not saved/i);
  });

  it("reveals a row's note input only after that row has a verdict", () => {
    const { rerender } = render(<FactorSessionList {...base} rows={rows([{ id: "a", count: 1 }])} />);
    expect(screen.queryByLabelText(/note on/i)).toBeNull();
    rerender(<FactorSessionList {...base} rows={rows([{ id: "a", count: 1 }])} verdictFor={() => "wrong"} />);
    expect(screen.getByLabelText(/note on/i)).toBeTruthy();
  });

  it("posts a note with the row's own sessionId and current verdict", () => {
    const onNote = vi.fn();
    render(<FactorSessionList {...base} rows={rows([{ id: "a", count: 1 }])} verdictFor={() => "wrong"} onNote={onNote} />);
    const input = screen.getByLabelText(/note on/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "flaky test" } });
    fireEvent.blur(input);
    expect(onNote).toHaveBeenCalledWith("a", FACTOR, "wrong", "flaky test");
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
pnpm --filter @agentgem/console test -- factorSessionList
```

Expected: FAIL — `../FactorSessionList.js` does not exist.

- [ ] **Step 3: Write the component**

Create `packages/console/src/panels/Rubrics/FactorSessionList.tsx`:

```tsx
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/console/src/panels/Rubrics/FactorSessionList.tsx
//
// The sessions one factor fired in, each with its own verdict controls. This is what
// lets calibration accumulate at project/all scope, where the fires actually are — a
// factor showing "93 in 65 sessions" here yields 65 reviewable calls, against 3 at
// session scope.
//
// Presentational by contract: `rows` arrive already filtered to this factor and
// already sorted. The component owns nothing but its batch window. Same split as
// HygieneLeaderboard, and it is what makes the sort testable without a DOM.
import { useRef, useState } from "react";
import { VERDICT_LABELS, verdictKeyOf, type PerSessionRow, type VerdictValueView } from "./rubricStream.js";

/** Rows revealed per click. Small on purpose: the point is to start judging, not to scroll. */
export const BATCH_SIZE = 10;

function FireRow({ row, factorId, verdict, note, onRecord, onNote, failed }: {
  row: PerSessionRow;
  factorId: string;
  verdict?: VerdictValueView;
  note?: string;
  onRecord: (sessionId: string, factorId: string, verdict: VerdictValueView) => void;
  onNote: (sessionId: string, factorId: string, verdict: VerdictValueView, note: string) => void;
  failed: boolean;
}) {
  const count = row.factors.find((f) => f.id === factorId)?.count ?? 0;
  // Tracks the text last sent, so blur only re-POSTs on an actual edit.
  const lastPosted = useRef(note ?? "");
  return (
    <li className="rub-fire-row" data-testid="rub-fire-row">
      <span className="rub-fire-name">{row.transcript}</span>
      <span className="rub-fire-count">{count}×</span>
      <span className="rub-call-actions" role="group" aria-label={`Your call on ${row.transcript}`}>
        {VERDICT_LABELS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            className={"rub-call-btn" + (verdict === value ? " is-on" : "")}
            aria-pressed={verdict === value}
            // row.sessionId, never a value closed over from the panel — this row's
            // own session is the only correct half of the key.
            onClick={() => onRecord(row.sessionId, factorId, value)}
          >{label}</button>
        ))}
        {verdict && (
          <input
            type="text"
            className="rub-call-note"
            maxLength={500}
            placeholder="why? (optional)"
            aria-label={`Note on ${row.transcript}`}
            defaultValue={note ?? ""}
            onBlur={(e) => {
              const text = e.target.value;
              if (text === lastPosted.current) return;
              lastPosted.current = text;
              onNote(row.sessionId, factorId, verdict, text);
            }}
          />
        )}
      </span>
      {failed && <span className="rub-fire-failed">not saved — try again</span>}
    </li>
  );
}

export function FactorSessionList({
  factorId, rows, summarySessions, truncated, verdictFor, noteFor, onRecord, onNote, failedIds,
}: {
  factorId: string;
  /** Already filtered to this factor's fires and already sorted. */
  rows: PerSessionRow[];
  /** The factor summary's `sessions` — the number the cap is measured against. */
  summarySessions: number;
  /** report.perSessionTruncated: the report's 200-row cap tripped. */
  truncated: boolean;
  verdictFor: (sessionId: string) => VerdictValueView | undefined;
  noteFor: (sessionId: string) => string | undefined;
  onRecord: (sessionId: string, factorId: string, verdict: VerdictValueView) => void;
  onNote: (sessionId: string, factorId: string, verdict: VerdictValueView, note: string) => void;
  failedIds: ReadonlySet<string>;
}) {
  const [shown, setShown] = useState(BATCH_SIZE);
  const visible = rows.slice(0, shown);
  // Two different truncations, never conflated (spec §4). `available` is what this
  // report carried; `missing` is what the 200-row cap kept it from carrying at all.
  // Saying "showing 3 of 3" while 37 fires were invisible would be the list-shaped
  // version of the denominator the rate itself refuses to quote.
  const available = rows.length;
  const missing = truncated ? Math.max(0, summarySessions - available) : 0;
  return (
    <div className="rub-fire-list">
      <ul className="rub-fire-rows">
        {visible.map((row) => (
          <FireRow
            key={row.sessionId}
            row={row}
            factorId={factorId}
            verdict={verdictFor(row.sessionId)}
            note={noteFor(row.sessionId)}
            onRecord={onRecord}
            onNote={onNote}
            failed={failedIds.has(verdictKeyOf(row.sessionId, factorId))}
          />
        ))}
      </ul>
      <p className="rub-fire-footer" data-testid="rub-fire-footer">
        showing {visible.length} of {available} available
        {missing > 0 && <> · {missing} more beyond this report&apos;s 200-session cap</>}
        {shown < available && (
          <button type="button" className="rub-fire-more" onClick={() => setShown((n) => n + BATCH_SIZE)}>
            Show more
          </button>
        )}
      </p>
    </div>
  );
}
```

- [ ] **Step 4: Add the CSS**

In `packages/console/src/shell/theme.css`, next to the existing `.rub-call-*` rules. Confirm each `var(--…)` token exists in `:root` before using it; `--ink-soft`, `--paper`, `--line`, and `--raised` all do.

```css
.rub-fire-list {
  margin: 6px 0 0 24px;
  border-left: 1px solid var(--line);
  padding-left: 10px;
}
.rub-fire-rows { list-style: none; margin: 0; padding: 0; }
.rub-fire-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
  font-size: 12px;
}
.rub-fire-name {
  color: var(--ink-soft);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 320px;
}
.rub-fire-count { color: var(--ink-soft); opacity: 0.7; min-width: 28px; }
.rub-fire-failed { color: var(--accent); font-size: 11px; }
.rub-fire-footer {
  margin: 6px 0 0;
  font-size: 11px;
  color: var(--ink-soft);
  opacity: 0.8;
}
.rub-fire-more {
  margin-left: 8px;
  padding: 1px 8px;
  font: inherit;
  font-size: 11px;
  color: var(--ink-soft);
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: 999px;
  cursor: pointer;
}
.rub-fire-more:hover { background: var(--raised); }
```

- [ ] **Step 5: Verify every class has a rule and the file is still text**

```bash
for c in rub-fire-list rub-fire-rows rub-fire-row rub-fire-name rub-fire-count rub-fire-failed rub-fire-footer rub-fire-more; do
  printf '%s: ' "$c"; grep -c "\.$c" packages/console/src/shell/theme.css
done
grep -q . packages/console/src/panels/Rubrics/FactorSessionList.tsx && echo TEXT_OK || echo BINARY_BAD
```

Expected: every count ≥ 1, and `TEXT_OK`.

- [ ] **Step 6: Run the tests and verify they pass**

```bash
pnpm --filter @agentgem/console test -- factorSessionList
pnpm --filter @agentgem/console typecheck
```

Expected: 9 passed, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add packages/console/src/panels/Rubrics/FactorSessionList.tsx packages/console/src/panels/Rubrics/__tests__/factorSessionList.test.tsx packages/console/src/shell/theme.css
git commit -m "feat(console): the sessions one factor fired in

Presentational by contract: rows arrive filtered and sorted, and the
component owns nothing but its batch window. That is what makes the
ordering testable without a DOM, and it is the same split
HygieneLeaderboard uses.

The footer states two truncations separately. The batch is a UI choice a
click undoes. The report's 200-row cap is data that was never carried,
shared across all factors, so a factor claiming 40 sessions can arrive
with 3 rows — and saying 'showing 3 of 3' alone would imply a coverage
the report does not have.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Wire the list into the factor rows

**Files:**
- Modify: `packages/console/src/panels/Rubrics/index.tsx` (`FactorRow` props + toggle + slot; card computes fires)
- Modify: `packages/console/src/shell/theme.css` (toggle rule)
- Test: `packages/console/src/panels/Rubrics/__tests__/verdictControls.test.tsx` (extend)

**Interfaces:**
- Consumes: `FactorSessionList` (Task 2), `verdictKeyOf` / `PerSessionRow` (Task 1).
- Produces: no new exports. `FactorRow` gains `fires?: PerSessionRow[]`, `summarySessions`, `truncated`, `verdictFor`, `noteFor`, `onRecordFor`, `onNoteFor`, `failedIds`.

- [ ] **Step 1: Write the failing test**

Append to `packages/console/src/panels/Rubrics/__tests__/verdictControls.test.tsx`:

```tsx
describe("per-session expansion at project scope", () => {
  const projectReport = (): RubricReportView => ({
    rubricId: "hygiene",
    target: "overview",
    scope: "project",
    factors: [
      { id: "retry-storm", title: "Retry storm", advice: "a", severity: "warn", count: 9, sessions: 3 },
    ],
    sessionsScanned: 100,
    clean: false,
    degraded: false,
    skippedFactors: [],
    perSession: [
      { sessionId: "s1", transcript: "/tmp/s1.jsonl", factors: [{ id: "retry-storm", title: "Retry storm", advice: "a", severity: "warn", count: 2, sessions: 1 }] },
      { sessionId: "s2", transcript: "/tmp/s2.jsonl", factors: [{ id: "retry-storm", title: "Retry storm", advice: "a", severity: "warn", count: 6, sessions: 1 }] },
      { sessionId: "s3", transcript: "/tmp/s3.jsonl", factors: [{ id: "retry-storm", title: "Retry storm", advice: "a", severity: "warn", count: 1, sessions: 1 }] },
    ],
  });

  it("keeps the aggregate row button-free at project scope", () => {
    render(<RubricReportCard report={projectReport()} client={client} />);
    // The toggle is present; the three verdict buttons are not.
    expect(screen.getByRole("button", { name: /unreviewed/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^wrong/i })).toBeNull();
  });

  it("is collapsed until the toggle is clicked", () => {
    render(<RubricReportCard report={projectReport()} client={client} />);
    expect(screen.queryAllByTestId("rub-fire-row")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /unreviewed/i }));
    expect(screen.getAllByTestId("rub-fire-row")).toHaveLength(3);
  });

  it("sorts the expansion worst-first", () => {
    render(<RubricReportCard report={projectReport()} client={client} />);
    fireEvent.click(screen.getByRole("button", { name: /unreviewed/i }));
    const names = screen.getAllByTestId("rub-fire-row").map((n) => n.textContent ?? "");
    expect(names[0]).toContain("s2.jsonl");   // 6 fires
    expect(names[1]).toContain("s1.jsonl");   // 2
    expect(names[2]).toContain("s3.jsonl");   // 1
  });

  it("posts the expanded row's own sessionId, not the panel's selection", async () => {
    // The panel is pointed at a DIFFERENT session on purpose: the shipped `record`
    // used to close over that value, and it is still in scope at the new call site.
    const mod = await import("../rubricStream.js");
    const spy = vi.spyOn(mod, "postRubricVerdict").mockResolvedValue({
      ok: true, atMs: 1, calibration: { reviewed: 1, accepted: 0, wrong: 1, wontfix: 0 },
    });
    render(<RubricReportCard report={projectReport()} sessionId="SOME-OTHER-SESSION" client={client} />);
    fireEvent.click(screen.getByRole("button", { name: /unreviewed/i }));
    const first = screen.getAllByTestId("rub-fire-row")[0];
    fireEvent.click(within(first).getByRole("button", { name: /^wrong/i }));
    expect(spy.mock.calls[0][1].body.sessionId).toBe("s2");
  });

  it("does not re-order the list when a verdict is recorded", async () => {
    const mod = await import("../rubricStream.js");
    vi.spyOn(mod, "postRubricVerdict").mockResolvedValue({
      ok: true, atMs: 1, calibration: { reviewed: 1, accepted: 0, wrong: 1, wontfix: 0 },
    });
    render(<RubricReportCard report={projectReport()} client={client} />);
    fireEvent.click(screen.getByRole("button", { name: /unreviewed/i }));
    const before = screen.getAllByTestId("rub-fire-row").map((n) => n.textContent ?? "");
    fireEvent.click(within(screen.getAllByTestId("rub-fire-row")[0]).getByRole("button", { name: /^wrong/i }));
    const after = screen.getAllByTestId("rub-fire-row").map((n) => n.textContent ?? "");
    expect(after.map((s) => s.split("×")[0])).toEqual(before.map((s) => s.split("×")[0]));
  });

  it("counts unreviewed fires on the toggle", () => {
    const r = projectReport();
    r.perSession![1].verdicts = { "retry-storm": { sessionId: "s2", factorId: "retry-storm", rubricId: "hygiene", verdict: "wrong", atMs: 1 } };
    render(<RubricReportCard report={r} client={client} />);
    expect(screen.getByRole("button", { name: /2 unreviewed/i })).toBeTruthy();
  });

  it("offers no expansion on a factor that did not fire", () => {
    const r = projectReport();
    r.factors[0].count = 0;
    r.perSession = [];
    render(<RubricReportCard report={r} client={client} />);
    expect(screen.queryByRole("button", { name: /unreviewed|all reviewed/i })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
pnpm --filter @agentgem/console test -- verdictControls
```

Expected: FAIL — no toggle button exists.

- [ ] **Step 3: Give `FactorRow` the toggle and the slot**

In `index.tsx`, extend `FactorRow`'s props (after `failed?: boolean;`):

```tsx
  // The sessions this factor fired in, already filtered and sorted. Present only at
  // project/all scope — at session scope the row IS the session and carries its own
  // buttons instead.
  fires?: PerSessionRow[];
  summarySessions?: number;
  truncated?: boolean;
  verdictFor?: (sessionId: string) => VerdictValueView | undefined;
  noteFor?: (sessionId: string) => string | undefined;
  onRecordFor?: (sessionId: string, factorId: string, verdict: VerdictValueView) => void;
  onNoteFor?: (sessionId: string, factorId: string, verdict: VerdictValueView, note: string) => void;
  failedIds?: ReadonlySet<string>;
```

Inside the component, after the `canCall` line:

```tsx
  const [open, setOpen] = useState(false);
  // Expansion is the project/all-scope path to a verdict. It needs fires to show and
  // a write handler to be worth showing — a control that cannot act must not appear.
  const canExpand = fired && !canCall && !!fires?.length && !!onRecordFor;
  const unreviewed = fires?.filter((r) => !verdictFor?.(r.sessionId)).length ?? 0;
```

And render, immediately before the closing `</li>`:

```tsx
      {canExpand && (
        <button
          type="button"
          className="rub-fire-toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "▾" : "▸"} {unreviewed > 0 ? `${unreviewed} unreviewed` : "all reviewed"}
        </button>
      )}
      {canExpand && open && (
        <FactorSessionList
          factorId={f.id}
          rows={fires!}
          summarySessions={f.sessions}
          truncated={!!truncated}
          verdictFor={verdictFor!}
          noteFor={noteFor ?? (() => undefined)}
          onRecord={onRecordFor!}
          onNote={onNoteFor!}
          failedIds={failedIds ?? new Set()}
        />
      )}
```

Add `import { FactorSessionList } from "./FactorSessionList.js";` and add `useState` to the existing `react` import if it is not already there.

- [ ] **Step 4: Compute fires once in the card and pass them down**

In `RubricReportCard`, after the `stored` line, add:

```tsx
  // One pass over perSession per render, not one per factor per render. Sorted here
  // so FactorSessionList stays presentational and the order is testable without a DOM.
  const firesByFactor = useMemo(() => {
    const out = new Map<string, PerSessionRow[]>();
    for (const row of report.perSession ?? []) {
      for (const f of row.factors) {
        if (f.count <= 0) continue;
        const list = out.get(f.id) ?? [];
        list.push(row);
        out.set(f.id, list);
      }
    }
    const countIn = (row: PerSessionRow, id: string) => row.factors.find((f) => f.id === id)?.count ?? 0;
    for (const [id, list] of out) {
      // Worst-first, ties broken on sessionId so the order is total and stable.
      list.sort((a, b) => countIn(b, id) - countIn(a, id) || a.sessionId.localeCompare(b.sessionId));
    }
    return out;
  }, [report.perSession]);
```

Add `useMemo` to the existing `react` import.

Then extend the `<FactorRow …>` call site from Task 1 with:

```tsx
              fires={firesByFactor.get(f.id)}
              truncated={!!report.perSessionTruncated}
              verdictFor={(sid) => calls[verdictKeyOf(sid, f.id)]
                ?? report.perSession?.find((r) => r.sessionId === sid)?.verdicts?.[f.id]?.verdict}
              noteFor={(sid) => report.perSession?.find((r) => r.sessionId === sid)?.verdicts?.[f.id]?.note}
              onRecordFor={client ? record : undefined}
              onNoteFor={client ? (sid, fid, v, note) => record(sid, fid, v, note) : undefined}
              failedIds={failedIds}
```

- [ ] **Step 5: Add the toggle CSS**

```css
.rub-fire-toggle {
  margin: 4px 0 0 24px;
  padding: 0;
  font: inherit;
  font-size: 12px;
  color: var(--ink-soft);
  background: none;
  border: none;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.rub-fire-toggle:hover { color: var(--ink); }
```

Verify: `grep -c "\.rub-fire-toggle" packages/console/src/shell/theme.css` is ≥ 1, and that `--ink` exists in `theme.css` (substitute `--ink-1` or the nearest sibling token if not).

- [ ] **Step 6: Run the tests and verify they pass**

```bash
pnpm --filter @agentgem/console test -- verdictControls
pnpm --filter @agentgem/console test -- factorRow
pnpm --filter @agentgem/console test -- factorSessionList
pnpm --filter @agentgem/console typecheck
```

Expected: all pass, including every pre-existing session-scope test unchanged.

- [ ] **Step 7: Commit**

```bash
git add packages/console/src/panels/Rubrics/index.tsx packages/console/src/shell/theme.css packages/console/src/panels/Rubrics/__tests__/verdictControls.test.tsx
git commit -m "feat(console): expand a factor to judge the sessions it fired in

Calibration could only be recorded at session scope, where one factor
showed 3 fires against 93 across 65 sessions at project scope. The rate
needs samples and could only collect them where they are scarcest.

The aggregate row stays button-free: it spans many sessions and cannot
carry a (session, factor) verdict. The expansion carries the buttons,
each row keyed to its own session — the panel's selected session is
still in scope at that call site and is the wrong half of the key.

Fires are grouped and sorted once per render in the card, not per factor
per render, and the order does not change when a verdict lands. A list
that reshuffles under the cursor is hostile in exactly the rapid
consecutive calls this exists for.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Full verification and PR

**Files:** none, unless a failure turns one up.

- [ ] **Step 1: Run both suites**

```bash
pnpm --filter @agentgem/console test
pnpm --filter @agentgem/console typecheck
pnpm test
```

`pnpm test` runs `tsc -b && vitest run` over the root's compiled output. If anything fails, check whether it failed before this branch (`git stash && pnpm test`) and say so explicitly rather than absorbing a pre-existing failure.

- [ ] **Step 2: Verify in a real browser**

jsdom has no layout, so indentation, the disclosure affordance, and 65 rows of buttons can only be judged in Chrome. Use the `verify` skill:

1. `pnpm build`, then `AGENTGEM_HOME=$(mktemp -d) PORT=<free-port> node dist/client.js`. Confirm the port is yours: `lsof -p $(lsof -tnP -iTCP:<port> -sTCP:LISTEN) | grep cwd`.
2. `#/rubrics` → rubric `hygiene` → **Run rubric** on a real project row (project scope).
3. A fired factor shows `▸ N unreviewed` and **no** verdict buttons on the aggregate row.
4. Expand: rows are indented under the factor, worst-first, each with three styled pills — not raw gray browser buttons.
5. Click **Wrong** on the second row; only that row shows pressed, and the factor's calibration line above updates immediately.
6. Confirm the list does **not** re-order after that click.
7. Click **Show more** if the factor has more than 10 sessions; confirm the footer count tracks.
8. Switch to session scope; confirm the aggregate row still has its own buttons and no toggle.

- [ ] **Step 3: Confirm the branch is ahead of `origin/main` only**

```bash
git fetch origin && git log --oneline origin/main..HEAD && git log --oneline HEAD..origin/main
```

If the second command is non-empty, rebase (`git rebase origin/main`), then clean and rebuild before re-running the suites: `rm -rf dist tsconfig.tsbuildinfo packages/*/tsconfig.tsbuildinfo packages/*/dist && pnpm build`.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin verdict-session-list
gh pr create --title "feat(console): record rubric verdicts where the fires actually are" --body "$(cat <<'EOF'
#610 shipped verdict capture that works, at a scope where almost nobody will use it. Controls rendered only at session scope, which was the right constraint on the key and an unmeasured consequence: one factor showed **3** fires at session scope and **93 across 65 sessions** at project scope. The calibration rate needs samples and could only collect them where they are scarcest.

This expands a fired factor to reveal the sessions it fired in, each with its own controls.

- **Factor-first**, against what the earlier spec sketched. The job is judging one criterion, so consecutive calls on the same question stay fast and consistently calibrated.
- **The aggregate row stays button-free** at project/all scope — it spans many sessions and cannot carry a `(session, factor)` verdict.
- **Console-only.** Every field was already on `perSession[]`.
- **Two truncations, never conflated:** the batch is a UI choice a click undoes; the report's 200-row cap is data that was never carried, and the footer names it when it bit.
- **The list does not re-order when a verdict lands.**

Spec: `docs/superpowers/specs/2026-08-11-verdict-session-list-design.md`
Plan: `docs/superpowers/plans/2026-08-11-verdict-session-list.md`

Deferred (spec §9): the focused review queue. Noted honestly — if the accordion is tedious enough to suppress triage, low volume will look like low demand for the queue.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: Watch CI, then verify the conclusion**

```bash
gh run watch <run-id> --exit-status
gh run view <run-id> --json conclusion   # watch can exit 0 while conclusion=failure
```

Do not merge without asking. `gh pr merge --delete-branch` will also fail its delete step because `main` is checked out in another worktree — and it fails *hard enough to skip the delete entirely*, leaving both the local and remote branch alive. Verify and clean both up by hand afterward.

---

## Self-Review

**Spec coverage:** §1.1 factor-first → Task 3 sort + toggle. §1.2 inline disclosure → Task 3 slot. §1.3 aggregate row button-free → Task 3 `canExpand = fired && !canCall`, tested. §1.4 console-only → no server file in any task. §1.5 no re-sort → Task 3 test. §1.6 leaderboard untouched → no task touches it. §2 data → Task 3 `firesByFactor`. §3 layout → Tasks 2-3. §4 two truncations → Task 2 footer + two tests. §5 sort → Task 3 `firesByFactor`. §6 boundary + notes → Task 2 component, notes in `FireRow`. §7 re-keying → Task 1. §8 all nine tests → Tasks 1-3 plus Task 4 Step 2.

**Type consistency:** `PerSessionRow`, `VerdictValueView`, `VERDICT_LABELS`, `verdictKeyOf` are each defined once in `rubricStream.ts` (Task 1) and imported by name everywhere after. `record(sessionId, factorId, verdict, note?)` has one signature, used by both `onRecordFor` and `onNoteFor`. `FactorSessionList`'s props in Task 2 Step 3 match its call site in Task 3 Step 3 field for field.

**Known soft spot:** Task 3 shows only the changed regions of `index.tsx`, which is 585 lines. The unchanged parts of `RubricReportCard` — the verdict summary line, coverage hints, hygiene block, degraded block, `calibrationUnavailable` banner, per-session tail, skipped-factors line — must survive verbatim. Read the file before editing.
