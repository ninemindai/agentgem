# Mine + Insights Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the standalone **Insights** tab into **Mine** as a second view behind a segmented control, sharing one project selector.

**Architecture:** `panels/Mine/index.tsx` becomes a thin shell owning `scope` (selected project, or `"*"`) and driving a two-tab sub-route bar (`#/mine` = Workflows, `#/mine/outcomes` = Outcomes) via the existing `useSubRouteTabs` hook (the Gems pattern). The current Mine scorecard body and the Insights report body are extracted into scope-aware view components. Both server streams already accept a project scope; the only server change is exposing the pre-existing `cacheOnly` option on the insights SSE endpoint so Outcomes can paint a cached report for free without a surprise LLM run.

**Tech Stack:** React 18 (function components + hooks), TypeScript (ESM, `.js` import specifiers), Vitest + @testing-library/react (jsdom), native SSE `EventSource`, pnpm workspace (`@agentgem/console`).

## Global Constraints

- **ESM import specifiers use `.js`** even for `.ts`/`.tsx` sources (e.g. `import { X } from "./foo.js"`). Match every existing import in the files you touch.
- **Console tests are NOT in CI** (memory `ci-skips-console-tests`). Run locally: `pnpm --filter @agentgem/console test` and `pnpm --filter @agentgem/console typecheck`. Root/server tests run via `pnpm --filter agentgem test` (or the repo root `pnpm test`).
- **Every new `ex-*`/CSS class needs a matching rule in the same change.** This plan reuses only existing classes (`console-tabs`, `console-tab`, `obs`, `mine`, `analyze`, `analyze-*`, `ledger-*`, `ws-chip`, `run-*`, `warming-pill`, `insights-*`, `targets-label`, `obs-head`, `obs-title`, `obs-empty`). If you add any class, add its rule to `packages/console/src/styles.css` and `grep -c` it before finishing.
- **Tab name stays "Mine"**; segment labels are **"Workflows"** and **"Outcomes"**.
- **Surgical diffs.** Do not reformat untouched code or restyle sibling components.
- **Commit after every task** with the message shown in that task's final step.
- Work in the worktree at `/Users/rfeng/Projects/ninemind/agentgem-worktrees/scratch` (branch `scratch`, off `origin/main`).

---

## File Structure (end state)

Under `packages/console/src/panels/Mine/`:
- `index.tsx` — **rewritten** into the shell (`Mine` component + `minePage`).
- `WorkflowsView.tsx` — **new**: extracted scorecard body, `WorkflowsView({ apiBase, scope, openStream? })`.
- `OutcomesView.tsx` — **new**: extracted Insights body (no picker), `OutcomesView({ apiBase, scope, openStream? })`.
- `ProjectScope.tsx` — **new**: shared project selector, `ProjectScope({ apiBase, scope, onChange })`.
- `OutcomesReport.tsx` — **moved** from `Insights/index.tsx` (`InsightsReportCard`).
- `insightsStream.ts` — **moved** from `Insights/` (+ `cacheOnly`/`fresh` opts, forward `cached`).
- `InsightsCharts.tsx` — **moved** from `Insights/`.
- `scorecardStream.ts` — **modified**: add `projects?: string[]` to opts.
- unchanged: `Scorecard.tsx`, `Workflows.tsx` (`MineWorkflows` — the workflow *table*), `card.ts`, `shareIntents.ts`, `ShareLinks.tsx`.

Modified elsewhere:
- `packages/console/src/pages.tsx` — drop `insightsPage`.
- `packages/console/src/registry.ts` — add legacy redirect `#/insights` → `#/mine/outcomes`.
- `src/insightsStream.ts` (server) — add `cacheOnly` query param.

Deleted:
- `packages/console/src/panels/Insights/index.tsx` and the emptied `Insights/` directory.

---

## Task 1: Relocate Insights modules under `Mine/`

Pure mechanical move so later tasks modify files in their final home. The standalone Insights page keeps working (its imports are repointed).

**Files:**
- Move: `packages/console/src/panels/Insights/insightsStream.ts` → `packages/console/src/panels/Mine/insightsStream.ts` (+ its test)
- Move: `packages/console/src/panels/Insights/InsightsCharts.tsx` → `packages/console/src/panels/Mine/InsightsCharts.tsx` (+ its test)
- Create: `packages/console/src/panels/Mine/OutcomesReport.tsx` (extract `InsightsReportCard`)
- Move: `packages/console/src/panels/Insights/InsightsReportCard.test.tsx` → `packages/console/src/panels/Mine/OutcomesReport.test.tsx`
- Modify: `packages/console/src/panels/Insights/index.tsx` (repoint imports; drop the extracted `InsightsReportCard` definition)

**Interfaces:**
- Produces: `OutcomesReport.tsx` exports `InsightsReportCard` (unchanged name/signature: `({ report, scanned, onBuild?, onContribute? })`). `Mine/insightsStream.ts` exports `openInsightsStream`, `InsightsReportView`, `InsightsEvent` (unchanged this task). `Mine/InsightsCharts.tsx` exports `OutcomesDonut`, `ByModelBars` (unchanged).

- [ ] **Step 1: Move the two modules and their tests with git**

```bash
cd /Users/rfeng/Projects/ninemind/agentgem-worktrees/scratch
git mv packages/console/src/panels/Insights/insightsStream.ts packages/console/src/panels/Mine/insightsStream.ts
git mv packages/console/src/panels/Insights/insightsStream.test.ts packages/console/src/panels/Mine/insightsStream.test.ts
git mv packages/console/src/panels/Insights/InsightsCharts.tsx packages/console/src/panels/Mine/InsightsCharts.tsx
git mv packages/console/src/panels/Insights/InsightsCharts.test.tsx packages/console/src/panels/Mine/InsightsCharts.test.tsx
git mv packages/console/src/panels/Insights/InsightsReportCard.test.tsx packages/console/src/panels/Mine/OutcomesReport.test.tsx
```

- [ ] **Step 2: Extract `InsightsReportCard` into `OutcomesReport.tsx`**

Create `packages/console/src/panels/Mine/OutcomesReport.tsx` by moving the `InsightsReportCard` function and `CANDIDATE_COLUMNS`/`PublishCandidate` helpers out of `Insights/index.tsx` **verbatim**, with imports repointed to the new location. Full file:

```tsx
import { useMemo, useState } from "react";
import type { InsightsReportView } from "./insightsStream.js";
import { OutcomesDonut, ByModelBars } from "./InsightsCharts.js";
import { useTableSort, type SortColumn } from "../../shell/useTableSort.js";
import { SortTh } from "../../shell/SortTh.js";
import { ReportActions } from "../../report/ReportActions.js";
import { insightsToBlocks, blocksToMarkdown, blocksToHtml } from "../../report/serialize.js";

type PublishCandidate = InsightsReportView["publish_candidates"][number];
const CANDIDATE_COLUMNS: SortColumn<PublishCandidate>[] = [
  { id: "goal", value: (c) => c.goal.toLowerCase() },
  { id: "why", value: (c) => c.why.toLowerCase() },
];

export function InsightsReportCard({ report, scanned, onBuild, onContribute }: { report: InsightsReportView; scanned?: number | null; onBuild?: () => void; onContribute?: () => void | Promise<void> }) {
  const [contributing, setContributing] = useState(false);
  const [contributeError, setContributeError] = useState<string | null>(null);
  const candidateSort = useTableSort(CANDIDATE_COLUMNS);

  const handleContribute = async () => {
    if (!onContribute) return;
    setContributing(true);
    setContributeError(null);
    try {
      await onContribute();
    } catch (e) {
      setContributeError(e instanceof Error ? e.message : "Prepare failed.");
    } finally {
      setContributing(false);
    }
  };

  const judged = report.totals.sessions;
  const capped = scanned != null && scanned > judged;
  const byModel = report.by_model ?? [];
  const publishCandidates = report.publish_candidates ?? [];
  const friction = report.friction ?? [];
  const blocks = useMemo(() => insightsToBlocks(report, scanned), [report, scanned]);
  const markdown = useMemo(() => blocksToMarkdown(blocks), [blocks]);
  const html = useMemo(() => blocksToHtml(blocks, "AgentGem Insights"), [blocks]);
  const json = useMemo(() => JSON.stringify(report, null, 2), [report]);
  return (
    <div className="insights-report">
      <ReportActions title="AgentGem Insights" filename="agentgem-insights" markdown={markdown} json={json} html={html} />
      {report.narrative && <p className="insights-narrative">{report.narrative}</p>}
      <p className="analyze-candidate-desc">{report.outcomes_summary}</p>
      {capped && <p className="insights-hint">Based on the {judged} most-recent of {scanned} sessions scanned.</p>}

      <OutcomesDonut totals={report.totals} />

      {byModel.length > 1 && (
        <div className="insights-section">
          <h4>By model</h4>
          <ByModelBars byModel={byModel} />
          <ul className="insights-bymodel">
            {byModel.map((m) => (
              <li key={m.model}>
                <span className="analyze-include-name">{m.model}</span>
                <span className="insights-rate">{Math.round((m.mostly / m.total) * 100)}% mostly</span>
                <span className="targets-label">{m.total} session{m.total === 1 ? "" : "s"}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {publishCandidates.length > 0 && (
        <div className="insights-section">
          <div className="analyze-candidate-head">
            <h4 style={{ margin: 0 }}>Worth publishing</h4>
            {onBuild && <button type="button" className="ledger-build" style={{ marginLeft: "auto" }} onClick={onBuild}>Build a Gem from this project →</button>}
            {onContribute && <button type="button" className="ledger-build" disabled={contributing} onClick={handleContribute}>{contributing ? "Preparing…" : "Publish"}</button>}
          </div>
          {contributeError && <p className="ledger-error">{contributeError}</p>}
          <table className="obs-table insights-candidates">
            <thead><tr>
              <SortTh label="goal" dir={candidateSort.dirFor("goal")} onClick={() => candidateSort.onSort("goal")} />
              <SortTh label="why" dir={candidateSort.dirFor("why")} onClick={() => candidateSort.onSort("why")} />
            </tr></thead>
            <tbody>
              {candidateSort.sort(publishCandidates).map((c) => (
                <tr key={c.sessionId}>
                  <td className="analyze-include-name">{c.goal}</td>
                  <td className="targets-label">{c.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {friction.length > 0 && (
        <div className="insights-section">
          <h4>Friction</h4>
          <ul className="analyze-include">
            {friction.map((f) => (
              <li key={f.sessionId}><span className="analyze-include-name">{f.detail}</span></li>
            ))}
          </ul>
        </div>
      )}

      {publishCandidates.length === 0 && friction.length === 0 && (
        <p className="ledger-empty">No standout sessions yet — keep working and re-run.</p>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Repoint `Insights/index.tsx`**

In `packages/console/src/panels/Insights/index.tsx`:
- Delete the `InsightsReportCard` function definition (now in `OutcomesReport.tsx`) and the now-unused `useMemo`, `useTableSort`/`SortColumn`, `SortTh`, `ReportActions`, `insightsToBlocks`/`blocksToMarkdown`/`blocksToHtml`, `CANDIDATE_COLUMNS`/`PublishCandidate` imports/consts.
- Repoint the remaining imports to the moved modules and import the card:

```tsx
import { openInsightsStream, type InsightsReportView } from "../Mine/insightsStream.js";
import { OutcomesDonut, ByModelBars } from "../Mine/InsightsCharts.js"; // (only if still referenced here; the Insights body itself uses InsightsReportCard, not the charts directly)
import { InsightsReportCard } from "../Mine/OutcomesReport.js";
```

> Note: `Insights/index.tsx` renders `<InsightsReportCard .../>` (line ~128) — that import above satisfies it. `OutcomesDonut`/`ByModelBars` are used *inside* the card, so `Insights/index.tsx` no longer imports them directly; remove that import if unreferenced.

- [ ] **Step 4: Fix the moved test imports**

In `packages/console/src/panels/Mine/OutcomesReport.test.tsx`, repoint the import of `InsightsReportCard` from `../Insights/index.js` (or wherever) to `./OutcomesReport.js`. In `Mine/insightsStream.test.ts` and `Mine/InsightsCharts.test.tsx`, update any relative import that changed depth (they stay two levels under `panels/`, so `../../` paths are unchanged; the `./insightsStream.js`/`./InsightsCharts.js` self-imports are unchanged).

- [ ] **Step 5: Run console tests + typecheck**

Run: `pnpm --filter @agentgem/console test && pnpm --filter @agentgem/console typecheck`
Expected: PASS (moved tests green; no unresolved imports).

- [ ] **Step 6: Commit**

```bash
git add -A packages/console/src/panels
git commit -m "refactor(console): relocate Insights stream/charts/report card under Mine"
```

---

## Task 2: Client stream signatures — scope + cacheOnly

**Files:**
- Modify: `packages/console/src/panels/Mine/scorecardStream.ts`
- Modify: `packages/console/src/panels/Mine/insightsStream.ts`
- Modify: `packages/console/src/panels/Insights/index.tsx` (update the one `openInsightsStream` call to the new opts shape)
- Test: `packages/console/src/panels/Mine/__tests__/scorecardStream.test.ts` (extend), `packages/console/src/panels/Mine/insightsStream.test.ts` (extend)

**Interfaces:**
- Produces:
  - `openScorecardStream(apiBase, onEvent, opts?: { refresh?: boolean; projects?: string[] }): () => void`
  - `openInsightsStream(apiBase, root, onEvent, opts?: { fresh?: boolean; cacheOnly?: boolean }): () => void`
  - `InsightsEvent` `done` variant gains `cached: boolean`.

- [ ] **Step 1: Write failing test — scorecard `projects` param**

In `packages/console/src/panels/Mine/__tests__/scorecardStream.test.ts`, add (mirroring the existing FakeES pattern in the file):

```ts
it("encodes a scoped project list into the query", () => {
  openScorecardStream("http://x", () => {}, { projects: ["/a", "/b"] });
  expect(FakeES.last!.url).toBe(`http://x/api/scorecard/stream?projects=${encodeURIComponent(JSON.stringify(["/a", "/b"]))}`);
});
it("omits the projects param when scope is undefined", () => {
  openScorecardStream("http://x", () => {});
  expect(FakeES.last!.url).toBe("http://x/api/scorecard/stream");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @agentgem/console test -- scorecardStream`
Expected: FAIL (projects not encoded).

- [ ] **Step 3: Implement `projects` in `scorecardStream.ts`**

Change the `opts` type and query build in `openScorecardStream`:

```ts
export function openScorecardStream(
  apiBase: string,
  onEvent: (e: ScorecardStreamEvent) => void,
  opts?: { refresh?: boolean; projects?: string[] },
): () => void {
  const params = new URLSearchParams();
  if (opts?.refresh) params.set("refresh", "true");
  if (opts?.projects?.length) params.set("projects", JSON.stringify(opts.projects));
  const qs = params.toString();
  const es = new EventSource(`${apiBase}/api/scorecard/stream${qs ? `?${qs}` : ""}`);
  // …rest unchanged…
```

- [ ] **Step 4: Write failing test — insights `cacheOnly`/`fresh` opts + `cached` forwarded**

In `packages/console/src/panels/Mine/insightsStream.test.ts`, add:

```ts
it("sets cacheOnly=1 when opts.cacheOnly", () => {
  openInsightsStream("http://x", "/proj", () => {}, { cacheOnly: true });
  expect(FakeES.last!.url).toContain("cacheOnly=1");
  expect(FakeES.last!.url).toContain("root=%2Fproj");
});
it("forwards the cached flag on done", () => {
  let ev: InsightsEvent | undefined;
  openInsightsStream("http://x", "/proj", (e) => { ev = e; });
  FakeES.last!.emit("done", { report: { totals: { sessions: 0, mostly: 0, partially: 0, not: 0 } }, cached: true, updatedAt: 42 });
  expect(ev).toMatchObject({ type: "done", cached: true, updatedAt: 42 });
});
```

> Match the existing FakeES helper in that test file for `emit`. If the file has no FakeES yet, mirror `scorecardStream.test.ts`'s fake.

- [ ] **Step 5: Run to verify failure**

Run: `pnpm --filter @agentgem/console test -- insightsStream`
Expected: FAIL (`cacheOnly`/`cached` unsupported).

- [ ] **Step 6: Implement opts + cached in `Mine/insightsStream.ts`**

```ts
export type InsightsEvent =
  | { type: "phase"; phase: string; transcripts?: number; sessions?: number }
  | { type: "delta"; text: string }
  | { type: "done"; report: InsightsReportView; degraded: boolean; cached: boolean; scanned?: number; updatedAt: number | null }
  | { type: "failed"; message: string };

export function openInsightsStream(
  apiBase: string,
  root: string,
  onEvent: (e: InsightsEvent) => void,
  opts?: { fresh?: boolean; cacheOnly?: boolean },
): () => void {
  const params = new URLSearchParams({ root });
  if (opts?.fresh) params.set("fresh", "1");
  if (opts?.cacheOnly) params.set("cacheOnly", "1");
  const es = new EventSource(`${apiBase}/api/insights/stream?${params.toString()}`);
  const data = (m: Event) => JSON.parse((m as MessageEvent).data);

  es.addEventListener("phase", (m) => {
    const d = data(m);
    onEvent({ type: "phase", phase: d.phase, transcripts: d.transcripts, sessions: d.sessions });
  });
  es.addEventListener("delta", (m) => onEvent({ type: "delta", text: data(m).text }));
  es.addEventListener("done", (m) => {
    const d = data(m);
    onEvent({ type: "done", report: d.report, degraded: !!d.degraded, cached: !!d.cached, scanned: d.signalSummary?.sessionsScanned, updatedAt: typeof d.updatedAt === "number" ? d.updatedAt : null });
    es.close();
  });
  es.addEventListener("failed", (m) => { onEvent({ type: "failed", message: data(m).message }); es.close(); });
  es.addEventListener("error", () => onEvent({ type: "failed", message: "stream connection error" }));

  return () => es.close();
}
```

- [ ] **Step 7: Update the caller in `Insights/index.tsx`**

Change `generate`'s call from positional `fresh` to opts:

```tsx
closeRef.current = openInsightsStream(apiBase, path, (e) => {
  // …unchanged handlers…
}, { fresh });
```

- [ ] **Step 8: Run tests + typecheck**

Run: `pnpm --filter @agentgem/console test && pnpm --filter @agentgem/console typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add -A packages/console/src/panels
git commit -m "feat(console): scope param on scorecard stream; cacheOnly + cached on insights stream"
```

---

## Task 3: Server — expose `cacheOnly` on the insights SSE endpoint

**Files:**
- Modify: `src/insightsStream.ts`
- Test: `src/__tests__/insightsStream.test.ts` (create if absent; else extend)

**Interfaces:**
- Consumes: `computeInsights(root, { dir, force, cacheOnly, progress })` — `cacheOnly` already exists in `insightsCore.ts`.
- Produces: `GET /api/insights/stream?root=…&cacheOnly=1` returns `done` with `cached:false` + empty report on a cache miss, never spending the LLM.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/insightsStream.test.ts` (mirror the fake-req/res shape used in `src/__tests__/scorecardStream.test.ts`):

```ts
import { describe, it, expect, vi } from "vitest";
import { streamInsights } from "../insightsStream.js";
import * as core from "../insightsCore.js";

function fakeRes() {
  const events: { event: string; data: unknown }[] = [];
  let buf = "";
  return {
    events,
    writeHead() {},
    write(c: string) {
      buf += c;
      const m = buf.match(/^event: (.+)\ndata: (.+)\n\n$/);
      if (m) { events.push({ event: m[1], data: JSON.parse(m[2]) }); buf = ""; }
    },
    end() {},
  };
}

describe("streamInsights", () => {
  it("passes cacheOnly through to computeInsights", async () => {
    const spy = vi.spyOn(core, "computeInsights").mockResolvedValue({
      payload: { report: { totals: { sessions: 0, mostly: 0, partially: 0, not: 0 } } } as never,
      cached: false, updatedAt: null,
    });
    const res = fakeRes();
    await streamInsights({ query: { root: "/proj", cacheOnly: "1" } }, res);
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ cacheOnly: true });
    expect(res.events.at(-1)?.event).toBe("done");
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter agentgem test -- insightsStream`
Expected: FAIL (`cacheOnly` not forwarded).

- [ ] **Step 3: Implement**

In `src/insightsStream.ts`, read the query flag and pass it through:

```ts
  const fresh = req.query.fresh === "1";   // bypass the cache (Re-run)
  const cacheOnly = req.query.cacheOnly === "1"; // peek: cached report or empty, never the LLM
  // …
    const { payload, cached, updatedAt } = await computeInsights(root, {
      dir, force: fresh, cacheOnly,
      progress: {
        onPhase: (phase, extra) => send("phase", { phase, ...(extra ?? {}) }),
        onDelta: (text) => send("delta", { text }),
      },
    });
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter agentgem test -- insightsStream`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src/insightsStream.ts src/__tests__/insightsStream.test.ts
git commit -m "feat(insights): expose cacheOnly on the insights SSE endpoint"
```

---

## Task 4: Legacy route redirect `#/insights` → `#/mine/outcomes`

**Files:**
- Modify: `packages/console/src/registry.ts` (the `LEGACY_ROUTES` table)
- Test: `packages/console/src/registry.test.ts` (extend; create if absent)

**Interfaces:**
- Consumes: existing `normalizeHash(hash)` + `LEGACY_ROUTES`.
- Produces: `normalizeHash("#/insights") === "#/mine/outcomes"`.

- [ ] **Step 1: Write the failing test**

In `packages/console/src/registry.test.ts` add:

```ts
it("redirects the legacy #/insights route to the Outcomes sub-route", () => {
  expect(normalizeHash("#/insights")).toBe("#/mine/outcomes");
});
it("passes #/mine and #/mine/outcomes through unchanged", () => {
  expect(normalizeHash("#/mine")).toBe("#/mine");
  expect(normalizeHash("#/mine/outcomes")).toBe("#/mine/outcomes");
});
```

(Import `normalizeHash` from `./registry.js` at the top if not already.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @agentgem/console test -- registry`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `packages/console/src/registry.ts`, add one entry to `LEGACY_ROUTES`:

```ts
const LEGACY_ROUTES: Record<string, string> = {
  "#/your-gems": "#/gems",
  "#/received": "#/gems/received",
  "#/get-gems": "#/gems/market",
  "#/inspect": "#/overview",
  "#/insights": "#/mine/outcomes", // Insights folded into Mine as the Outcomes view
};
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @agentgem/console test -- registry`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A packages/console/src/registry.ts packages/console/src/registry.test.ts
git commit -m "feat(console): redirect legacy #/insights to #/mine/outcomes"
```

---

## Task 5: `ProjectScope` shared selector

**Files:**
- Create: `packages/console/src/panels/Mine/ProjectScope.tsx`
- Test: `packages/console/src/panels/Mine/ProjectScope.test.tsx`

**Interfaces:**
- Consumes: `testbedProjectsRoute`, `testbedRecentsRoute`, `makeClient`, `RecentEntry`, `ProjectCandidate` from `../../api/routes.js`.
- Produces: `ProjectScope({ apiBase, scope, onChange })` where `scope: string` (a project path or `"*"`), `onChange: (scope: string) => void`. Renders a searchable list with **"All projects"** (`"*"`) leading; clicking a row calls `onChange(path)`. The currently-selected row is marked `is-active`.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { ProjectScope } from "./ProjectScope.js";
import * as routes from "../../api/routes.js";

afterEach(cleanup);

describe("ProjectScope", () => {
  it("lists All projects first and calls onChange on select", async () => {
    vi.spyOn(routes, "testbedProjectsRoute", "get" as never).mockReturnValue({ call: async () => ({ projects: [{ path: "/a", flavor: "claude", name: "a" }] }) } as never);
    vi.spyOn(routes, "testbedRecentsRoute", "get" as never).mockReturnValue({ call: async () => ({ recents: [] }) } as never);
    const onChange = vi.fn();
    render(<ProjectScope apiBase="http://x" scope="*" onChange={onChange} />);
    await waitFor(() => screen.getByText("All projects"));
    fireEvent.click(screen.getByText(/a$/));
    expect(onChange).toHaveBeenCalledWith("/a");
  });
});
```

> If mocking the route objects by getter is awkward in this codebase, prefer the existing test approach used by `Insights` tests (e.g. `vi.mock("../../api/routes.js", …)`); mirror whatever `panels/Insights` tests already do to stub `testbedProjectsRoute`/`testbedRecentsRoute`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @agentgem/console test -- ProjectScope`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `ProjectScope.tsx`**

```tsx
import { useEffect, useState } from "react";
import { testbedRecentsRoute, testbedProjectsRoute, makeClient, type RecentEntry, type ProjectCandidate } from "../../api/routes.js";

function short(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 3 ? "…/" + parts.slice(-3).join("/") : path;
}

/** Shared project selector for the Mine tab. "All projects" (root "*") leads the
 *  list; both the Workflows and Outcomes views scope to the chosen project. */
export function ProjectScope({ apiBase, scope, onChange }: { apiBase: string; scope: string; onChange: (scope: string) => void }) {
  const [projects, setProjects] = useState<ProjectCandidate[] | null>(null);
  const [recents, setRecents] = useState<RecentEntry[] | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const client = makeClient(apiBase);
    testbedProjectsRoute.call(client).then((r) => setProjects(r.projects)).catch(() => setProjects([]));
    testbedRecentsRoute.call(client).then((r) => setRecents(r.recents)).catch(() => setRecents([]));
  }, [apiBase]);

  const rows = (() => {
    const seen = new Set<string>();
    const acc: { path: string; flavor: string; label: string }[] = [];
    for (const r of recents ?? []) { if (!seen.has(r.path)) { seen.add(r.path); acc.push({ path: r.path, flavor: r.flavor, label: r.name }); } }
    for (const p of projects ?? []) { if (!seen.has(p.path)) { seen.add(p.path); acc.push({ path: p.path, flavor: p.flavor, label: short(p.path) }); } }
    const q = query.trim().toLowerCase();
    const matched = q ? acc.filter((r) => r.label.toLowerCase().includes(q) || r.path.toLowerCase().includes(q)) : acc;
    return [{ path: "*", flavor: "all", label: "All projects" }, ...matched.slice(0, 40)];
  })();

  return (
    <div className="mine-scope">
      {(projects || recents) && (
        <input
          className="ledger-search"
          type="text"
          placeholder="search projects…"
          aria-label="search projects"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ marginBottom: 12 }}
        />
      )}
      <ul className="analyze-list">
        {rows.map((r) => (
          <li className={"analyze-row" + (scope === r.path ? " is-active" : "")} key={r.path}>
            <button
              type="button"
              className="analyze-row-head"
              aria-pressed={scope === r.path}
              onClick={() => onChange(r.path)}
              style={{ width: "100%", textAlign: "left", background: "none", border: "none", cursor: "pointer" }}
            >
              <span className="analyze-name">{r.label}</span>
              <span className="ws-chip">{r.flavor}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

> `mine-scope` is a layout wrapper only; if you give it any visual style, add the rule to `styles.css` in this task. All other classes (`analyze-list`, `analyze-row`, `analyze-name`, `ws-chip`, `ledger-search`) already exist. The inline `style` on the button avoids a new class for the reset — acceptable and matches the inline-style usage already in these panels.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @agentgem/console test -- ProjectScope`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A packages/console/src/panels/Mine/ProjectScope.tsx packages/console/src/panels/Mine/ProjectScope.test.tsx
git commit -m "feat(console): shared ProjectScope selector for the Mine tab"
```

---

## Task 6: `OutcomesView` (Insights body, no picker, scope-driven)

**Files:**
- Create: `packages/console/src/panels/Mine/OutcomesView.tsx`
- Test: `packages/console/src/panels/Mine/OutcomesView.test.tsx`

**Interfaces:**
- Consumes: `openInsightsStream` (Task 2 signature, with `cached`), `InsightsReportCard` (`./OutcomesReport.js`), `setPendingAnalyze`/`setPendingPlaybook`, `timeAgo`.
- Produces: `OutcomesView({ apiBase, scope, openStream? })`. `openStream` defaults to `openInsightsStream` (injectable for tests). On mount / `scope` change it opens a **cacheOnly peek**; a `done` with `cached:true` paints the report, otherwise it shows a "Generate report" prompt. Never auto-runs the LLM.

- [ ] **Step 1: Write the failing tests**

```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { OutcomesView } from "./OutcomesView.js";
import type { InsightsEvent } from "./insightsStream.js";

afterEach(cleanup);

function fakeStream() {
  const calls: { root: string; opts: unknown; emit: (e: InsightsEvent) => void }[] = [];
  const open = (_api: string, root: string, onEvent: (e: InsightsEvent) => void, opts?: unknown) => {
    calls.push({ root, opts, emit: onEvent });
    return () => {};
  };
  return { calls, open };
}
const emptyReport = { totals: { sessions: 0, mostly: 0, partially: 0, not: 0 }, outcomes_summary: "", narrative: "", by_model: [], friction: [], publish_candidates: [] };

describe("OutcomesView", () => {
  it("peeks the cache with cacheOnly on mount and does not auto-run the LLM", () => {
    const s = fakeStream();
    render(<OutcomesView apiBase="http://x" scope="/proj" openStream={s.open as never} />);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].opts).toMatchObject({ cacheOnly: true });
  });

  it("shows Generate when the peek reports no cache", () => {
    const s = fakeStream();
    render(<OutcomesView apiBase="http://x" scope="/proj" openStream={s.open as never} />);
    s.calls[0].emit({ type: "done", report: emptyReport as never, degraded: false, cached: false, updatedAt: null });
    expect(screen.getByRole("button", { name: /generate/i })).toBeTruthy();
  });

  it("generate opens a compute stream (no cacheOnly)", () => {
    const s = fakeStream();
    render(<OutcomesView apiBase="http://x" scope="/proj" openStream={s.open as never} />);
    s.calls[0].emit({ type: "done", report: emptyReport as never, degraded: false, cached: false, updatedAt: null });
    fireEvent.click(screen.getByRole("button", { name: /generate/i }));
    expect(s.calls[1].opts ?? {}).not.toMatchObject({ cacheOnly: true });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @agentgem/console test -- OutcomesView`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `OutcomesView.tsx`**

```tsx
import { useEffect, useRef, useState } from "react";
import { openInsightsStream, type InsightsReportView, type InsightsEvent } from "./insightsStream.js";
import { InsightsReportCard } from "./OutcomesReport.js";
import { setPendingAnalyze, setPendingPlaybook } from "../../pendingAnalyze.js";
import { timeAgo } from "../../util/timeAgo.js";

/** The Outcomes view of the Mine tab: an LLM-judged per-session report for the
 *  scoped project. Peeks the cache (cacheOnly) on scope change and paints a cached
 *  report instantly; the expensive judge runs only on an explicit Generate/Refresh. */
export function OutcomesView({ apiBase, scope, openStream = openInsightsStream }: { apiBase: string; scope: string; openStream?: typeof openInsightsStream }) {
  const [phase, setPhase] = useState("");
  const [out, setOut] = useState("");
  const [report, setReport] = useState<InsightsReportView | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [scanned, setScanned] = useState<number | null>(null);
  const [degraded, setDegraded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const closeRef = useRef<(() => void) | null>(null);

  const reset = () => { setPhase(""); setOut(""); setReport(null); setUpdatedAt(null); setScanned(null); setDegraded(false); setError(null); };

  const run = (opts: { fresh?: boolean; cacheOnly?: boolean }) => {
    closeRef.current?.();
    reset();
    setRunning(!opts.cacheOnly); // a peek doesn't show the running/Reading state
    closeRef.current = openStream(apiBase, scope, (e: InsightsEvent) => {
      if (e.type === "phase") setPhase(e.sessions != null ? `${e.phase} (${e.sessions} sessions)` : e.phase);
      else if (e.type === "delta") setOut((o) => o + e.text);
      else if (e.type === "done") {
        setRunning(false);
        // A cacheOnly peek that missed (cached:false, no real report) → leave the
        // Generate prompt up; only paint when there's a genuine cached/computed report.
        if (opts.cacheOnly && !e.cached) return;
        setPhase("done"); setReport(e.report); setUpdatedAt(e.updatedAt); setScanned(e.scanned ?? null); setDegraded(e.degraded);
      }
      else if (e.type === "failed") { setError(e.message); setRunning(false); }
    }, opts);
  };

  // Peek the cache whenever the scoped project changes. Never spends the LLM.
  useEffect(() => { run({ cacheOnly: true }); return () => closeRef.current?.(); }, [apiBase, scope]); // eslint-disable-line react-hooks/exhaustive-deps

  const canBuild = scope !== "*";
  return (
    <section className="analyze">
      <p className="analyze-intro">agentgem reads this project's sessions and tells you what you were working on, how it went, and which wins are worth publishing.</p>
      <div className="run-out analyze-status">
        <div className="run-status">
          <span className={"run-badge " + (error ? "run-failed" : running ? "run-running" : "run-done")}>
            {error ? "failed" : phase || (running ? "Reading…" : report ? "done" : "not run")}
          </span>
          {degraded && !error && <span className="ws-chip" title="The local agent was unavailable; showing a basic report.">basic</span>}
          {report && !running && updatedAt != null && (
            <span className="ledger-muted" style={{ marginLeft: "auto", marginRight: 8 }}>updated {timeAgo(updatedAt)}</span>
          )}
          {!running && (
            <button
              type="button"
              className="ledger-view"
              style={report && updatedAt != null ? undefined : { marginLeft: "auto" }}
              onClick={() => run({ fresh: !!report })}
            >{report ? "Refresh ↻" : "Generate report →"}</button>
          )}
        </div>
        {error && <p className="ledger-error">{error}</p>}
        {out && !report && <pre className="run-transcript">{out}</pre>}
        {report && (
          <InsightsReportCard
            report={report}
            scanned={scanned}
            onBuild={canBuild ? () => { setPendingAnalyze(scope); window.location.hash = "#/curate"; } : undefined}
            onContribute={canBuild ? () => { setPendingPlaybook({ root: scope }); window.location.hash = "#/curate"; } : undefined}
          />
        )}
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @agentgem/console test -- OutcomesView`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A packages/console/src/panels/Mine/OutcomesView.tsx packages/console/src/panels/Mine/OutcomesView.test.tsx
git commit -m "feat(console): Outcomes view — scoped insights report with cache peek + explicit generate"
```

---

## Task 7: `WorkflowsView` + Mine shell wiring

**Files:**
- Create: `packages/console/src/panels/Mine/WorkflowsView.tsx` (extracted scorecard body, scope-aware)
- Rewrite: `packages/console/src/panels/Mine/index.tsx` (shell)
- Test: `packages/console/src/panels/Mine/__tests__/MineShell.test.tsx`

**Interfaces:**
- Consumes: `ScorecardHero`/`ScorecardHeroSkeleton`/`ScorecardScanning`/`WorkflowFilter` (`./Scorecard.js`), `MineWorkflows` (`./Workflows.js`), `openScorecardStream` (Task 2, with `projects`), `scorecardBuildRoute`, `ProjectScope`, `OutcomesView`, `useSubRouteTabs`.
- Produces:
  - `WorkflowsView({ apiBase, scope, openStream? })` — the current Mine scorecard, passing `projects:[scope]` when `scope !== "*"`.
  - `Mine({ apiBase })` shell + `minePage` (route `#/mine`, unchanged metadata).

- [ ] **Step 1: Create `WorkflowsView.tsx` from the current `Mine` body**

Move the entire current body of `Mine` (from `index.tsx`) into `WorkflowsView`, adding `scope` handling. Full file:

```tsx
import { useEffect, useRef, useState } from "react";
import type { Scorecard } from "../../api/routes.js";
import { scorecardBuildRoute, makeClient } from "../../api/routes.js";
import { ScorecardHero, ScorecardHeroSkeleton, ScorecardScanning } from "./Scorecard.js";
import type { WorkflowFilter } from "./Scorecard.js";
import { openScorecardStream, type ScorecardStreamEvent } from "./scorecardStream.js";
import { MineWorkflows } from "./Workflows.js";

type Progress = { done: number; total: number; label: string; partial: { breadth: number; battleTested: number; portable: number } };

export function WorkflowsView({ apiBase, scope, openStream = openScorecardStream }: { apiBase: string; scope: string; openStream?: typeof openScorecardStream }) {
  const [scorecard, setScorecard] = useState<Scorecard | null>(null);
  const [scorecardUpdatedAt, setScorecardUpdatedAt] = useState<number | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [phase, setPhase] = useState<"loading" | "scanning" | "done" | "failed">("loading");
  const [revalidating, setRevalidating] = useState(false);
  const [filter, setFilter] = useState<WorkflowFilter>("all");
  const [building, setBuilding] = useState(false);
  const [buildResult, setBuildResult] = useState<{ name: string; skills: string[] } | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const freshRef = useRef(false);

  useEffect(() => {
    setScorecard(null); setScorecardUpdatedAt(null); setProgress(null); setPhase("loading"); setFilter("all"); setRevalidating(false);
    const fresh = freshRef.current; freshRef.current = false;
    const projects = scope === "*" ? undefined : [scope];
    const close = openStream(apiBase, (e: ScorecardStreamEvent) => {
      if (e.type === "start") setPhase((p) => (p === "done" ? p : "scanning"));
      else if (e.type === "stale") { setScorecard(e.scorecard); setScorecardUpdatedAt(e.updatedAt); setPhase("done"); setRevalidating(true); }
      else if (e.type === "progress") { setProgress({ done: e.done, total: e.total, label: e.label, partial: e.partial }); setPhase((p) => (p === "done" ? p : "scanning")); }
      else if (e.type === "done") { setScorecard(e.scorecard); setScorecardUpdatedAt(e.updatedAt); setPhase("done"); setRevalidating(false); }
      else if (e.type === "failed") setPhase("failed");
    }, { refresh: fresh || undefined, projects });
    return close;
  }, [apiBase, openStream, reloadKey, scope]);

  const onRescan = () => { freshRef.current = true; setReloadKey((k) => k + 1); };

  const onBuild = async (selections: { root: string; keys: string[] }[], name: string) => {
    setBuilding(true);
    setBuildResult(null);
    setBuildError(null);
    try {
      const gem = await scorecardBuildRoute.call(makeClient(apiBase), { body: { selections, name } });
      const skills = gem.artifacts.filter((a) => a.type === "skill").map((a) => a.name);
      setBuildResult({ name: gem.name, skills });
    } catch (err) {
      setBuildError(err instanceof Error ? err.message : "Build failed");
    } finally {
      setBuilding(false);
    }
  };

  return (
    <div className="obs mine">
      {phase === "done" && scorecard
        ? <>
            {revalidating && (
              <span className="warming-pill" title="Rescanning your projects in the background — the scorecard refreshes automatically.">
                <span className="warming-pill__spark" aria-hidden="true">✦</span>
                updating…
              </span>
            )}
            <ScorecardHero data={scorecard} updatedAt={scorecardUpdatedAt} onRescan={onRescan} />
            <MineWorkflows data={scorecard} filter={filter} onFilter={setFilter} onBuild={onBuild} building={building} result={buildResult} error={buildError} apiBase={apiBase} />
          </>
        : phase === "failed"
          ? <p className="obs-empty">Couldn't compute your goldmine right now — try again shortly.</p>
          : phase === "scanning"
            ? <ScorecardScanning progress={progress} />
            : <ScorecardHeroSkeleton />}
    </div>
  );
}
```

> Note the `openStream` opts change: `{ refresh: fresh || undefined, projects }` (was `fresh ? { refresh: true } : undefined`). `refresh: undefined` is falsy, so the query stays clean when not rescanning.

- [ ] **Step 2: Write the failing shell test**

Create `packages/console/src/panels/Mine/__tests__/MineShell.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Mine } from "../index.js";

vi.mock("../WorkflowsView.js", () => ({ WorkflowsView: (p: { scope: string }) => <div>workflows:{p.scope}</div> }));
vi.mock("../OutcomesView.js", () => ({ OutcomesView: (p: { scope: string }) => <div>outcomes:{p.scope}</div> }));
vi.mock("../ProjectScope.js", () => ({ ProjectScope: (p: { onChange: (s: string) => void }) => <button onClick={() => p.onChange("/x")}>pick</button> }));

afterEach(() => { cleanup(); window.location.hash = ""; });
beforeEach(() => { window.location.hash = "#/mine"; });

describe("Mine shell", () => {
  it("shows Workflows by default", () => {
    render(<Mine apiBase="http://x" />);
    expect(screen.getByText("workflows:*")).toBeTruthy();
  });
  it("shows Outcomes at #/mine/outcomes", () => {
    window.location.hash = "#/mine/outcomes";
    render(<Mine apiBase="http://x" />);
    expect(screen.getByText("outcomes:*")).toBeTruthy();
  });
  it("propagates the shared scope to the active view", () => {
    render(<Mine apiBase="http://x" />);
    fireEvent.click(screen.getByText("pick"));
    expect(screen.getByText("workflows:/x")).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @agentgem/console test -- MineShell`
Expected: FAIL (shell not implemented).

- [ ] **Step 4: Rewrite `Mine/index.tsx` as the shell**

```tsx
import { useState } from "react";
import { defineConsolePage } from "../../registry.js";
import { useSubRouteTabs } from "../../shell/useSubRouteTabs.js";
import { ProjectScope } from "./ProjectScope.js";
import { WorkflowsView } from "./WorkflowsView.js";
import { OutcomesView } from "./OutcomesView.js";

const TABS = [
  { id: "workflows", label: "Workflows", route: "#/mine" },
  { id: "outcomes", label: "Outcomes", route: "#/mine/outcomes" },
] as const;

/** The Mine tab: a shared project selector over two views — Workflows (the
 *  deterministic scorecard) and Outcomes (the LLM-judged session report). */
export function Mine({ apiBase }: { apiBase: string }) {
  const [scope, setScope] = useState("*");
  const { idx, roving } = useSubRouteTabs(TABS.map((t) => t.route));

  return (
    <div className="mine-tab">
      <ProjectScope apiBase={apiBase} scope={scope} onChange={setScope} />
      <div className="console-tabs" role="tablist" aria-label="Mine" {...roving.containerProps}>
        {TABS.map((t, i) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={i === idx}
            className={"console-tab" + (i === idx ? " is-active" : "")}
            {...roving.getTabProps(i)}
            onClick={() => { window.location.hash = t.route; }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {idx === 1
          ? <OutcomesView apiBase={apiBase} scope={scope} />
          : <WorkflowsView apiBase={apiBase} scope={scope} />}
      </div>
    </div>
  );
}

export const minePage = defineConsolePage({
  id: "mine", title: "Mine", icon: "💎", order: 10, phase: "observe", category: "projects",
  route: "#/mine", component: Mine,
});
```

> `mine-tab` is a bare wrapper; add a `styles.css` rule only if you give it layout. `console-tabs`/`console-tab` already exist (Gems). The tab click sets the hash directly (mirrors Gems' `go`); `useSubRouteTabs` re-derives `idx` on the resulting `hashchange`.

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @agentgem/console test -- MineShell`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A packages/console/src/panels/Mine
git commit -m "feat(console): Mine shell with Workflows/Outcomes sub-route tabs + shared scope"
```

---

## Task 8: Remove the standalone Insights page

**Files:**
- Delete: `packages/console/src/panels/Insights/index.tsx` (and the now-empty `Insights/` dir)
- Modify: `packages/console/src/pages.tsx`

**Interfaces:**
- Consumes: nothing new. `minePage` now owns both views; `#/insights` redirects via Task 4.

- [ ] **Step 1: Delete the Insights page**

```bash
cd /Users/rfeng/Projects/ninemind/agentgem-worktrees/scratch
git rm packages/console/src/panels/Insights/index.tsx
# Confirm the directory is empty (all other files moved in Task 1):
ls packages/console/src/panels/Insights 2>/dev/null || echo "Insights dir gone"
```

- [ ] **Step 2: Drop `insightsPage` from `pages.tsx`**

In `packages/console/src/pages.tsx`:
- Remove the import line: `import { insightsPage } from "./panels/Insights/index.js";`
- Remove `insightsPage` from the `pages` array.

- [ ] **Step 3: Grep for any dangling references**

Run: `grep -rn "insightsPage\|panels/Insights" packages/console/src`
Expected: no matches (empty output).

- [ ] **Step 4: Full console + server test + typecheck**

Run:
```bash
pnpm --filter @agentgem/console test
pnpm --filter @agentgem/console typecheck
pnpm --filter agentgem test -- insightsStream
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A packages/console/src
git commit -m "feat(console): remove standalone Insights tab (folded into Mine)"
```

---

## Task 9: Whole-app verification

**Files:** none (verification only).

- [ ] **Step 1: Build the console package**

Run: `pnpm --filter @agentgem/console build`
Expected: success (no unresolved imports from the moves/deletes).

- [ ] **Step 2: Drive the real UI** (per the `/run` + `verify` skills)

Launch the console, then confirm by observation (screenshots):
1. `#/mine` shows the segmented control (Workflows | Outcomes), Workflows selected, scorecard auto-streams, "All projects" selected in the scope list.
2. Picking a project in the scope list re-streams the Workflows scorecard scoped to it.
3. Switching to **Outcomes** shows the scoped project with a **Generate report** button and does NOT start an LLM run on switch.
4. Clicking **Generate** streams the report; after it lands the button reads **Refresh**.
5. Navigating to `#/insights` redirects to `#/mine/outcomes`.

- [ ] **Step 3: Final full test run + typecheck**

Run: `pnpm --filter @agentgem/console test && pnpm --filter @agentgem/console typecheck && pnpm --filter agentgem test`
Expected: PASS. (No commit — this task is verification.)

---

## Self-Review

**Spec coverage:**
- One tab, two views → Tasks 5–7 (shell + ProjectScope + WorkflowsView + OutcomesView). ✅
- Shared project context → `ProjectScope` (Task 5) owned by the shell (Task 7), passed to both views. ✅
- Outcomes explicit-generate + SWR cached paint → Task 6 (cacheOnly peek + Generate/Refresh) backed by Task 2 (`cached` flag) + Task 3 (server `cacheOnly`). ✅
- Workflows scoped via `projects` param → Task 2 (`scorecardStream`) + Task 7 (`WorkflowsView` passes `[scope]`). ✅
- Routing `#/mine` / `#/mine/outcomes`, legacy `#/insights` redirect → Task 7 (sub-route tabs) + Task 4 (LEGACY_ROUTES). ✅
- Nav placement unchanged (observe/projects/order 10), Insights removed → Task 7 (`minePage` metadata) + Task 8 (`pages.tsx`). ✅
- Module relocation under Mine → Task 1. ✅
- Tests for normalizeHash, shell, scorecard `projects`, Outcomes no-auto-run → Tasks 4, 7, 2, 6. ✅

**Deviations from the spec (intentional, discovered during planning):**
1. **Segments are path sub-routes (`#/mine/outcomes`), not `?view=`.** The codebase's established tabbed-panel pattern (Gems) uses hash sub-routes + `useSubRouteTabs`; following it is lower-risk than inventing a query-param convention.
2. **Outcomes' instant cached paint requires a one-line server change** (`cacheOnly` on the insights SSE endpoint, Task 3) — the spec's "no server change" held only for the scorecard side. This wires an option `computeInsights` already supports; it is the honest way to peek the cache without risking a surprise LLM run.
3. **View components are named `WorkflowsView`/`OutcomesView`**, not `Workflows`/`Outcomes` — `Mine/Workflows.tsx` already exists (`MineWorkflows`, the workflow table).

**Placeholder scan:** none — every code step shows complete code; move steps show exact `git mv` + the specific import edits.

**Type consistency:** `openScorecardStream(apiBase, onEvent, { refresh?, projects? })` and `openInsightsStream(apiBase, root, onEvent, { fresh?, cacheOnly? })` are used identically in Tasks 2, 6, 7. `InsightsEvent.done.cached: boolean` defined in Task 2, consumed in Task 6. `WorkflowsView`/`OutcomesView`/`ProjectScope` prop shapes match their call sites in the shell (Task 7).
