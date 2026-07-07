# Cross-Session Context-Hygiene Leaderboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a built-in `context-hygiene` rubric and a worst-first leaderboard of the sessions that tripped a hygiene factor, in the existing Rubrics panel, each row deep-linking to its #161 per-session report.

**Architecture:** One `Rubric` literal referencing the five cheap hygiene detectors; one `hygiene?` field computed per `perSession` entry in `rubricReport.ts` (via the already-imported `hygieneScore`/`assessesHygiene`); one leaderboard render branch in `RubricReportCard`. Everything else — the scan, detectors, scoring, panel run/scope/stream — is reused. The rubric scan is Claude-only, so every leaderboard row deep-links to `#/inspect/claude/<sessionId>`.

**Tech Stack:** TypeScript ESM (`.js` specifiers), React (console), Vitest (server: `tsc -b && vitest run` over `dist/**/__tests__/**/*.test.js`; console: its own jsdom vitest).

## Global Constraints

- **Depends on PR #153 + #161 (both merged):** the five hygiene detectors (`task-sprawl`, `task-pingpong`, `reread-churn`, `context-pinned`, `cache-churn-late`) are in `DETECTORS`; `hygieneScore`, `assessesHygiene`, `HygieneVerdict` are exported from `packages/insight/src/contextHygiene.ts` and ALREADY imported in `rubricReport.ts` (line 18); `RubricReport.hygiene?: HygieneVerdict` already exists.
- **Distinct rubric id:** the new rubric is `context-hygiene`. Do NOT edit or overload the existing `"hygiene"` rubric (whose factors are `retry-storm`/`thrash-loop`/`no-verify-finish`).
- **Copyright header** on new files: `// Copyright (c) 2026 NineMind, Inc.` / `// SPDX-License-Identifier: MIT` / `// <repo-relative path>`.
- **ESM import specifiers end in `.js`**.
- **Claude-only scan:** `rubricCore.ts` scans `allClaudeTranscripts`; every session is Claude, so leaderboard rows link to `#/inspect/claude/<sessionId>` (no agent threading).
- **Additive:** `hygiene?` on the per-session entry is optional; non-hygiene rubrics and their existing rendering are unaffected (the leaderboard branch only activates when entries carry `hygiene`).
- **Privacy:** `perSession` already carries `sessionId` + `transcript` (basename) + `DetectorSummary` counts/advice; the added `hygiene` is a verdict/score. No `arg`/path introduced.
- **Server tests** in `src/gem/__tests__/` (IN CI). **Console tests** are NOT in root CI — run via the console's own vitest.
- **`grep -a`** when searching `packages/insight/src/workflowScan.ts` (binary-classified).
- **Commit identity** Raymond Feng <raymond@ninemind.ai>, with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.

---

## File Structure

- **Modify** `packages/insight/src/rubrics.ts` — add the `context-hygiene` rubric to `builtinRubrics()`. (Task 1)
- **Modify** `packages/insight/src/rubricReport.ts` — add `hygiene?` to the `perSession` interface (line 38) + compute it at the build site (line 156). (Task 2)
- **Modify** `packages/console/src/panels/Rubrics/rubricStream.ts` — mirror `hygiene?` on the client `perSession` type. (Task 3)
- **Modify** `packages/console/src/panels/Rubrics/index.tsx` — the leaderboard render branch in `RubricReportCard`. (Task 3)
- **Modify** `packages/console/src/shell/theme.css` — minimal leaderboard table styles. (Task 3)
- **Create** `src/gem/__tests__/contextHygieneRubric.test.ts` — rubric + per-session-verdict tests (CI). (Tasks 1, 2)
- **Create** `packages/console/src/panels/Rubrics/__tests__/HygieneLeaderboard.test.tsx` — leaderboard render test (local). (Task 3)

**Run commands** (repo root `/Users/rfeng/Projects/ninemind/agentgem`):
- Server single test: `tsc -b && npx vitest run dist/gem/__tests__/contextHygieneRubric.test.js`
- Full server suite: `npm test`
- Console tests (local): `cd packages/console && npx vitest run src/panels/Rubrics/__tests__/HygieneLeaderboard.test.tsx` ; typecheck `cd packages/console && npx tsc -b`

---

## Task 1: The built-in `context-hygiene` rubric

**Files:**
- Modify: `packages/insight/src/rubrics.ts` (the array in `builtinRubrics()`, ~line 170)
- Test: `src/gem/__tests__/contextHygieneRubric.test.ts`

**Interfaces:**
- Consumes: the `Rubric` type + `builtinRubrics`, `scopeAllowed` from `./rubrics.js`; `HYGIENE_FACTOR_IDS` from `@agentgem/insight`.
- Produces: a `context-hygiene` entry in `builtinRubrics()` with the five hygiene factor refs.

- [ ] **Step 1: Write the failing test**

Create `src/gem/__tests__/contextHygieneRubric.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/__tests__/contextHygieneRubric.test.ts
import { describe, it, expect } from "vitest";
import { builtinRubrics, scopeAllowed, HYGIENE_FACTOR_IDS } from "@agentgem/insight";

describe("context-hygiene built-in rubric", () => {
  const rubric = () => builtinRubrics().find((r) => r.id === "context-hygiene")!;

  it("exists, is distinct from the 'hygiene' rubric, and references exactly the five hygiene factors", () => {
    const r = rubric();
    expect(r).toBeDefined();
    expect(r.id).not.toBe("hygiene");
    const factorIds = r.factors.map((f) => f.factor).sort();
    expect(factorIds).toEqual([...HYGIENE_FACTOR_IDS].sort());
  });

  it("is runnable at scope 'all' and 'project' (session-granular, all cheap)", () => {
    const r = rubric();
    expect(scopeAllowed(r, "all")).toBe(true);
    expect(scopeAllowed(r, "project")).toBe(true);
    expect(r.naturalScope).toBe("all");
  });

  it("leaves the pre-existing 'hygiene' rubric untouched (process-quality factors)", () => {
    const legacy = builtinRubrics().find((r) => r.id === "hygiene")!;
    expect(legacy.factors.map((f) => f.factor)).toContain("retry-storm");
    expect(legacy.factors.map((f) => f.factor)).not.toContain("context-pinned");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `tsc -b && npx vitest run dist/gem/__tests__/contextHygieneRubric.test.js`
Expected: FAIL — no `context-hygiene` rubric.

- [ ] **Step 3: Write minimal implementation**

In `packages/insight/src/rubrics.ts`, add the new rubric to the array returned by `builtinRubrics()` (after the existing `hygiene` entry). Confirm the array shape first with `grep -an "export function builtinRubrics" packages/insight/src/rubrics.ts`:

```ts
    {
      id: "context-hygiene",
      title: "Context hygiene",
      target: "overview",
      naturalScope: "all",
      factors: [
        { factor: "task-sprawl" },
        { factor: "task-pingpong" },
        { factor: "reread-churn" },
        { factor: "context-pinned" },
        { factor: "cache-churn-late" },
      ],
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `tsc -b && npx vitest run dist/gem/__tests__/contextHygieneRubric.test.js`
Then confirm no regression in the rubric suite: `npx vitest run dist/gem/__tests__/insightsReport.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/rubrics.ts src/gem/__tests__/contextHygieneRubric.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(insight): context-hygiene built-in rubric (five cheap factors)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Per-session hygiene verdict on the report

**Files:**
- Modify: `packages/insight/src/rubricReport.ts` (interface ~line 38; build site ~line 156)
- Test: `src/gem/__tests__/contextHygieneRubric.test.ts` (append)

**Interfaces:**
- Consumes: `hygieneScore`, `assessesHygiene`, `HygieneVerdict` (already imported in `rubricReport.ts` at line 18); `evaluateRubric`, `builtinRubrics` from `@agentgem/insight`; `scanWorkflow` for the fixture.
- Produces: `RubricReport.perSession` entries gain `hygiene?: HygieneVerdict` — set to `hygieneScore(entry.factors)` when `assessesHygiene(entry.factors)`, else undefined.

- [ ] **Step 1: Write the failing test** (append to `contextHygieneRubric.test.ts`)

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanWorkflow, evaluateRubric } from "@agentgem/insight";

const emptyInv = { project: { root: "/r", skills: [], mcpServers: [], hooks: [], instructions: [] }, global: { skills: [], mcpServers: [], hooks: [] } } as any;

// A bloated session: pinned at the 1M cap across many turns + sprawl across clusters.
function writeBloated(dir: string, name: string): string {
  const lines: string[] = [JSON.stringify({ sessionId: name, type: "user", message: { role: "user", content: "go" } })];
  for (let i = 0; i < 30; i++) lines.push(JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant", model: "claude-opus-4-8[1m]",
      content: [{ type: "tool_use", name: "Read", input: { file_path: `packages/p${i % 8}/f.ts` } }],
      usage: { input_tokens: 100, cache_read_input_tokens: 990_000, cache_creation_input_tokens: 5000, output_tokens: 10 },
    },
  }));
  const p = join(dir, `${name}.jsonl`); writeFileSync(p, lines.join("\n")); return p;
}
// A clean session: short, tiny window, one cluster.
function writeClean(dir: string, name: string): string {
  const lines = [
    JSON.stringify({ sessionId: name, type: "user", message: { role: "user", content: "go" } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", model: "claude-opus-4-8[1m]",
      content: [{ type: "tool_use", name: "Read", input: { file_path: "packages/a/f.ts" } }],
      usage: { input_tokens: 100, cache_read_input_tokens: 8000, cache_creation_input_tokens: 500, output_tokens: 10 } } }),
  ];
  const p = join(dir, `${name}.jsonl`); writeFileSync(p, lines.join("\n")); return p;
}

describe("evaluateRubric — per-session hygiene verdict", () => {
  const ctxRubric = () => builtinRubrics().find((r) => r.id === "context-hygiene")!;

  it("attaches a hygiene verdict to each tripped perSession entry; clean session is absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lb-"));
    const signal = scanWorkflow([writeBloated(dir, "bad1"), writeClean(dir, "good1")], emptyInv, { retainSequences: true });
    const report = await evaluateRubric(signal, ctxRubric(), { scope: { kind: "all" } } as any);
    const ids = (report.perSession ?? []).map((s) => s.sessionId);
    expect(ids).toContain("bad1");
    expect(ids).not.toContain("good1");                    // clean → no findings → not enumerated
    const bad = report.perSession!.find((s) => s.sessionId === "bad1")!;
    expect(bad.hygiene).toBeDefined();
    expect(bad.hygiene!.verdict).toBe("bloated");
  });

  it("leaves perSession hygiene undefined for a non-hygiene rubric", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lb2-"));
    const signal = scanWorkflow([writeBloated(dir, "bad2")], emptyInv, { retainSequences: true });
    const legacy = builtinRubrics().find((r) => r.id === "hygiene")!;
    const report = await evaluateRubric(signal, legacy, { scope: { kind: "all" } } as any);
    for (const s of report.perSession ?? []) expect(s.hygiene).toBeUndefined();
  });
});
```

> Note: confirm `evaluateRubric`'s `opts` shape first (`grep -an "export async function evaluateRubric" packages/insight/src/rubricReport.ts` and read its `EvaluateOpts`); the fixture passes `{ scope: { kind: "all" } }` — adjust to the real option keys if they differ (the `as any` keeps it resilient, but match the real shape so it runs). If `evaluateRubric` requires an `AcpConnectFn` for LLM criteria, the context-hygiene/hygiene rubrics have none, so a minimal/omitted connect is fine.

- [ ] **Step 2: Run test to verify it fails**

Run: `tsc -b && npx vitest run dist/gem/__tests__/contextHygieneRubric.test.js`
Expected: FAIL — `bad.hygiene` is undefined (not yet computed).

- [ ] **Step 3: Write minimal implementation**

In `packages/insight/src/rubricReport.ts`:

1. Extend the `perSession` interface field (line ~38). Change:
   ```ts
   perSession?: { sessionId: string; transcript: string; factors: DetectorSummary[] }[];
   ```
   to:
   ```ts
   perSession?: { sessionId: string; transcript: string; factors: DetectorSummary[]; hygiene?: HygieneVerdict }[];
   ```

2. At the build site (line ~156), compute the verdict from each entry's factors. Change:
   ```ts
   report.perSession = withFindings.slice(0, PER_SESSION_CAP).map((s) => ({
     sessionId: s.sessionId,
     transcript: s.transcript,
     factors: summariesForSpecs(allSpecs, bySession.get(s.sessionId)!),
   }));
   ```
   to:
   ```ts
   report.perSession = withFindings.slice(0, PER_SESSION_CAP).map((s) => {
     const factors = summariesForSpecs(allSpecs, bySession.get(s.sessionId)!);
     return {
       sessionId: s.sessionId,
       transcript: s.transcript,
       factors,
       ...(assessesHygiene(factors) ? { hygiene: hygieneScore(factors) } : {}),
     };
   });
   ```

`hygieneScore`, `assessesHygiene`, `HygieneVerdict` are already imported at line 18 — no new import.

- [ ] **Step 4: Run test to verify it passes**

Run: `tsc -b && npx vitest run dist/gem/__tests__/contextHygieneRubric.test.js`
Then the rubric/scorecard suites to confirm the additive field didn't break them: `npx vitest run dist/gem/__tests__/scorecardBuild.test.js dist/gem/__tests__/scorecardRoute.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/rubricReport.ts src/gem/__tests__/contextHygieneRubric.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(insight): per-session hygiene verdict on RubricReport.perSession

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: The leaderboard UI

**Files:**
- Modify: `packages/console/src/panels/Rubrics/rubricStream.ts` (mirror `hygiene?` on the client `perSession` type)
- Modify: `packages/console/src/panels/Rubrics/index.tsx` (the leaderboard branch in `RubricReportCard`)
- Modify: `packages/console/src/shell/theme.css` (leaderboard styles)
- Test: `packages/console/src/panels/Rubrics/__tests__/HygieneLeaderboard.test.tsx`

**Interfaces:**
- Consumes: the `/api/rubric/stream` report (Task 2) now carrying per-session `hygiene`.
- Produces: a `HygieneLeaderboard` sub-component rendered by `RubricReportCard` when `perSession` entries carry `hygiene`.

- [ ] **Step 1: Write the failing test**

Create `packages/console/src/panels/Rubrics/__tests__/HygieneLeaderboard.test.tsx`:

```tsx
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/console/src/panels/Rubrics/__tests__/HygieneLeaderboard.test.tsx
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { HygieneLeaderboard } from "../HygieneLeaderboard.js";

afterEach(cleanup);

const rows = [
  { sessionId: "aaa", transcript: "aaa.jsonl", factors: [{ id: "context-pinned", title: "Window pinned at the context cap", advice: "", severity: "warn" as const, count: 3, sessions: 1 }], hygiene: { score: 20, verdict: "bloated" as const } },
  { sessionId: "bbb", transcript: "bbb.jsonl", factors: [{ id: "task-pingpong", title: "Ping-ponging between tasks", advice: "", severity: "info" as const, count: 1, sessions: 1 }], hygiene: { score: 60, verdict: "mixed" as const } },
];

describe("HygieneLeaderboard", () => {
  it("renders rows worst-first with verdict, score, and a deep-link to Inspect", () => {
    render(<HygieneLeaderboard perSession={rows} sessionsScanned={142} truncated={false} />);
    const list = screen.getAllByRole("listitem");
    expect(list).toHaveLength(2);
    expect(within(list[0]).getByText(/bloated/i)).toBeTruthy();   // worst (score 20) first
    expect(within(list[1]).getByText(/mixed/i)).toBeTruthy();
    const link = within(list[0]).getByRole("link");
    expect(link.getAttribute("href")).toBe("#/inspect/claude/aaa");
  });

  it("shows the scanned / needs-attention header", () => {
    render(<HygieneLeaderboard perSession={rows} sessionsScanned={142} truncated={false} />);
    expect(screen.getByText(/142 sessions scanned/i)).toBeTruthy();
    expect(screen.getByText(/2 need attention/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/console && npx vitest run src/panels/Rubrics/__tests__/HygieneLeaderboard.test.tsx`
Expected: FAIL — `../HygieneLeaderboard.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

In `packages/console/src/panels/Rubrics/rubricStream.ts`, extend the client `perSession` type (line ~21) to mirror the server. Add a local verdict type and the optional field:

```ts
export interface HygieneVerdictView { score: number; verdict: "bounded" | "mixed" | "bloated" }
```
Change:
```ts
  perSession?: { sessionId: string; transcript: string; factors: RubricFactorView[] }[];
```
to:
```ts
  perSession?: { sessionId: string; transcript: string; factors: RubricFactorView[]; hygiene?: HygieneVerdictView }[];
```

Create `packages/console/src/panels/Rubrics/HygieneLeaderboard.tsx`:

```tsx
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/console/src/panels/Rubrics/HygieneLeaderboard.tsx
import type { RubricReportView } from "./rubricStream.js";

type Row = NonNullable<RubricReportView["perSession"]>[number];

export function HygieneLeaderboard({ perSession, sessionsScanned, truncated }: {
  perSession: Row[]; sessionsScanned: number; truncated: boolean;
}) {
  // worst-first: ascending hygiene score (lower = more bloated). Entries without a
  // verdict sort last (shouldn't happen for a hygiene rubric, but stay total).
  const rows = [...perSession].sort((a, b) => (a.hygiene?.score ?? 101) - (b.hygiene?.score ?? 101));
  return (
    <div className="hyg-lb">
      <p className="insights-hint">
        {sessionsScanned} session{sessionsScanned === 1 ? "" : "s"} scanned · {perSession.length} need attention{truncated ? " (showing the first 200)" : ""}
      </p>
      <ul className="hyg-lb-list">
        {rows.map((r) => {
          const top = [...r.factors].filter((f) => f.count > 0).sort((a, b) => b.count - a.count)[0];
          const v = r.hygiene?.verdict ?? "bounded";
          return (
            <li key={r.sessionId} className="hyg-lb-row">
              <a className="hyg-lb-name" href={`#/inspect/claude/${r.sessionId}`}>{r.transcript}</a>
              <span className={"hyg-verdict is-" + v}><span className="hyg-word">{v}</span> <span className="hyg-score">{r.hygiene?.score ?? ""}</span></span>
              {top && <span className="hyg-lb-top ledger-muted">{top.title}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
```

In `packages/console/src/panels/Rubrics/index.tsx`: import the component and replace the bare "N sessions tripped a factor" block in `RubricReportCard` with a conditional — leaderboard when the entries carry `hygiene`, the existing line otherwise. Add `import { HygieneLeaderboard } from "./HygieneLeaderboard.js";` near the top, and change the `{affected > 0 && (...)}` block to:

```tsx
      {affected > 0 && (
        report.perSession!.some((s) => s.hygiene)
          ? <HygieneLeaderboard perSession={report.perSession!} sessionsScanned={report.sessionsScanned} truncated={!!report.perSessionTruncated} />
          : <p className="insights-hint">
              {affected} session{affected === 1 ? "" : "s"} tripped a factor{report.perSessionTruncated ? " (showing the first 200)" : ""}.
            </p>
      )}
```

Add minimal CSS to `packages/console/src/shell/theme.css` (near the other `.hyg-*` rules ~line 1007) for `.hyg-lb-list` (list-reset, gap), `.hyg-lb-row` (flex row, `gap`, align-baseline, a bottom hairline `border-bottom: 1px solid var(--line)`), `.hyg-lb-name` (link color `var(--accent)`, `font-variant-numeric: tabular-nums` off), `.hyg-lb-top` (smaller, muted). Reuse the existing `.hyg-verdict.is-*` classes for the chip — no new verdict colors.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/console && npx vitest run src/panels/Rubrics/__tests__/HygieneLeaderboard.test.tsx`
Then typecheck the console: `cd packages/console && npx tsc -b`
Then confirm the existing Rubrics panel tests still pass (non-hygiene fallback unaffected): `cd packages/console && npx vitest run src/panels/Rubrics`
Expected: all PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/panels/Rubrics/rubricStream.ts packages/console/src/panels/Rubrics/HygieneLeaderboard.tsx packages/console/src/panels/Rubrics/index.tsx packages/console/src/shell/theme.css packages/console/src/panels/Rubrics/__tests__/HygieneLeaderboard.test.tsx
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(console): worst-first context-hygiene leaderboard in the Rubrics panel

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] Server suite: `npm test` (includes `contextHygieneRubric.test.js` + unaffected rubric/scorecard suites).
- [ ] Console: `cd packages/console && npx vitest run src/panels/Rubrics && npx tsc -b`.
- [ ] Manual smoke (optional): open the console Rubrics panel, pick "Context hygiene", scope "all", run; confirm the aggregate verdict + five factors worst-first + a ranked leaderboard whose rows link through to Inspect → Session; pick a non-hygiene rubric and confirm the plain per-session line still shows (no leaderboard).

## Out of scope (later follow-ups)

- Ranking all scanned sessions including bounded ones (payload work).
- Tier-2 LLM boundary-judge; ambient warm-daemon nudging; the interactive EMBER widget.
- A dedicated leaderboard route/page; org-level aggregation.
