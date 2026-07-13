# Dreaming Live Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a live, faithful step tracker in the Journey tab as any warm pass runs (manual *or* automatic) — the three sleep phases plus the current project — and add the current phase to the global `warming…` pill.

**Architecture:** `runWarmPass` (`src/warm/orchestrator.ts`) publishes an incremental `progress` snapshot on its module-level `status` singleton as the loop advances. That rides along on the existing `GET /api/warm/status` and is folded into `GET /api/dream/status`. The Journey panel and `WarmingPill` render it by polling — fast while a pass runs, slow when idle. No push transport.

**Tech Stack:** TypeScript (Node ≥24, ESM), Zod (`@agentback/openapi` decorators), React 18 + Testing Library + vitest, hand-authored CSS.

## Global Constraints

- **Node ≥ 24**, ESM, relative imports carry `.js` extensions.
- **Root `src/` tests run against compiled `dist/`** — always `pnpm build` before `pnpm exec vitest run dist/...`. CI gates on the root `test (24)` job (root `dist/__tests__` + colocated `dist/**/__tests__`).
- **`packages/console` tests are NOT in CI** — run locally with `pnpm --filter @agentgem/console exec vitest run <src-path>` (console vitest runs on `src` `.tsx` directly, jsdom).
- **The console has NO CSS framework.** Every new class needs a hand-authored rule in `packages/console/src/shell/theme.css`, reusing the existing design tokens (`--ink`, `--ink-soft`, `--accent`, `--emerald`, `--line`, `--raised`, `--shadow-sm`, `--font-mono`, `--font-ui`, `warming-pulse`). Grep the class after adding: `grep -c "<class>" packages/console/src/shell/theme.css` must be > 0.
- **Copyright header** on every new file:
  ```
  // Copyright (c) 2026 NineMind, Inc.
  // SPDX-License-Identifier: MIT
  ```
- **Style:** root `src/` and `packages/console` use double quotes + semicolons. Match the file you edit.
- **Work on branch `feat/dream-live-progress`** (worktree `../agentgem-worktrees/dream-progress`). Commit messages end with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

## File map

- `src/warm/orchestrator.ts` — **modify**: add `WarmProgress`, `progress` field on `WarmStatus`, `PHASE_OF` (moved here), per-step publish. (Task 1)
- `src/warm/__tests__/orchestrator.test.ts` — **modify**: progress tests. (Task 1)
- `src/dream.controller.ts` — **modify**: import `PHASE_OF`, extend `StatusSchema` with `progress`, map it in `status()`. (Task 2)
- `src/__tests__/dream.controller.test.ts` — **modify**: mid-flight progress test. (Task 2)
- `packages/console/src/panels/Dreaming/api.ts` — **modify**: `DreamProgressData` type + `progress` on `DreamStatus`. (Task 3)
- `packages/console/src/panels/Dreaming/DreamProgress.tsx` — **create**: presentational step tracker. (Task 3)
- `packages/console/src/panels/Dreaming/DreamProgress.test.tsx` — **create**. (Task 3)
- `packages/console/src/shell/theme.css` — **modify**: `.dream-progress*` + `.warming-pill__phase` rules. (Tasks 3, 5)
- `packages/console/src/panels/Dreaming/index.tsx` — **modify**: adaptive poll, optimistic `pending`, render `DreamProgress`. (Task 4)
- `packages/console/src/panels/Dreaming/Dreaming.test.tsx` — **modify**: update the completion test, add a progress test. (Task 4)
- `packages/console/src/components/WarmingPill.tsx` + `.test.tsx` — **modify**: append current phase. (Task 5)

---

### Task 1: Publish live progress from the orchestrator

**Files:**
- Modify: `src/warm/orchestrator.ts`
- Test: `src/warm/__tests__/orchestrator.test.ts`

**Interfaces:**
- Produces:
  - `export const PHASE_OF: Record<string, "LIGHT" | "DEEP" | "REM">`
  - `export interface WarmProgress { startedAt: number; phase: "LIGHT" | "DEEP" | "REM" | null; phasesLit: Array<"LIGHT" | "DEEP" | "REM">; currentRoot: string | null; rootIndex: number; rootCount: number; done: number; total: number }`
  - `WarmStatus` gains `progress: WarmProgress | null`
- Consumes: existing `Warmable`, `WarmOutcome`, `runOne`.

- [ ] **Step 1: Write the failing tests**

Append to `src/warm/__tests__/orchestrator.test.ts` (and add `PHASE_OF` to the existing import on line 4: `import { runWarmPass, getWarmStatus, beginForeground, endForeground, PHASE_OF } from "../orchestrator.js";`):

```ts
describe("runWarmPass – live progress", () => {
  it("PHASE_OF maps the phased warmables", () => {
    expect(PHASE_OF.usage).toBe("LIGHT");
    expect(PHASE_OF.scorecard).toBe("LIGHT");
    expect(PHASE_OF.analyze).toBe("DEEP");
    expect(PHASE_OF.insights).toBe("REM");
  });

  it("computes total steps and clears progress when the pass ends", async () => {
    const reg: Warmable[] = [
      { id: "usage", cost: "cheap", scope: "global", async warm() { return "warmed"; } },
      { id: "insights", cost: "llm", scope: "per-root", async warm() { return "warmed"; } },
    ];
    await runWarmPass({ registry: reg, roots: ["/a", "/b"], topN: 2, now: () => 1, isBusy: () => false });
    const st = getWarmStatus();
    expect(st.progress).toBeNull();          // cleared at end
    expect(st.last?.outcomes).toHaveLength(3); // 1 global + 1 per-root × 2 roots
  });

  it("exposes the running phase/root/counts mid-pass", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const reg: Warmable[] = [
      { id: "usage", cost: "cheap", scope: "global", async warm() { return "warmed"; } },   // LIGHT
      { id: "analyze", cost: "llm", scope: "per-root", async warm() { await gate; return "warmed"; } }, // DEEP
    ];
    const pass = runWarmPass({ registry: reg, roots: ["/a", "/b"], topN: 2, now: () => 1, isBusy: () => false });
    await new Promise((r) => setTimeout(r, 0));  // let the loop reach the gated analyze:/a
    const mid = getWarmStatus();
    expect(mid.running).toBe(true);
    expect(mid.progress).not.toBeNull();
    expect(mid.progress!.total).toBe(3);
    expect(mid.progress!.rootCount).toBe(2);
    expect(mid.progress!.done).toBe(1);            // usage completed
    expect(mid.progress!.phase).toBe("DEEP");      // analyze is now running
    expect(mid.progress!.currentRoot).toBe("a");   // basename of /a
    expect(mid.progress!.rootIndex).toBe(1);
    expect(mid.progress!.phasesLit).toContain("LIGHT");
    release();
    await pass;
    expect(getWarmStatus().progress).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd /Users/rfeng/Projects/ninemind/agentgem-worktrees/dream-progress
pnpm build && pnpm exec vitest run dist/warm/__tests__/orchestrator.test.js
```
Expected: FAIL — `PHASE_OF` is not exported; `progress` is undefined on the status.

- [ ] **Step 3: Implement the progress publication**

In `src/warm/orchestrator.ts`:

Add the import at the top (after the existing imports):
```ts
import { basename } from "node:path";
```

Replace the types block (lines 16–19) with:
```ts
export type WarmItemStatus = "warmed" | "hit" | "skipped" | "error";
export interface WarmOutcome { id: string; root: string | null; status: WarmItemStatus }
export interface WarmPassResult { startedAt: number; finishedAt: number; outcomes: WarmOutcome[] }

// Phase mapping for the sleep-cycle UI (single source of truth; the dream
// controller imports this). Unmapped warmables (observe/recall/distill/dream)
// have no phase.
export const PHASE_OF: Record<string, "LIGHT" | "DEEP" | "REM"> = {
  usage: "LIGHT", scorecard: "LIGHT", analyze: "DEEP", insights: "REM",
};

// Live, incremental view of the in-flight pass (null when idle). Updated at
// warmable boundaries — a synchronous scan blocks the loop, so the tracker
// advances between steps, not continuously.
export interface WarmProgress {
  startedAt: number;
  phase: "LIGHT" | "DEEP" | "REM" | null;      // phase of the currently-running warmable
  phasesLit: Array<"LIGHT" | "DEEP" | "REM">;  // phases with ≥1 warmed/hit so far
  currentRoot: string | null;                  // display basename of the project (null for global steps)
  rootIndex: number;                           // 1-based within the current per-root warmable (0 for global)
  rootCount: number;                           // number of selected projects
  done: number;                                // steps completed
  total: number;                               // total steps this pass
}
export interface WarmStatus { running: boolean; last: WarmPassResult | null; progress: WarmProgress | null }
```

Replace the status singleton init (line 35) with:
```ts
let status: WarmStatus = { running: false, last: null, progress: null };
```

Replace the pass body from `status = { running: true, last: status.last };` (line 59) through the end of the loop (line 72) with:
```ts
  const startedAt = now();
  const outcomes: WarmOutcome[] = [];
  const phasesLit = new Set<"LIGHT" | "DEEP" | "REM">();
  const globalCount = registry.filter((w) => w.scope === "global").length;
  const total = globalCount + (registry.length - globalCount) * selectedRoots.length;
  let progress: WarmProgress = {
    startedAt, phase: null, phasesLit: [], currentRoot: null,
    rootIndex: 0, rootCount: selectedRoots.length, done: 0, total,
  };
  status = { running: true, last: status.last, progress };

  // Publish a fresh snapshot BEFORE a step (so pollers see the running warmable)
  // and AFTER (so `done`/`phasesLit` advance once it finishes).
  const beginStep = (w: Warmable, root: string | null, rootIndex: number): void => {
    progress = { ...progress, phase: PHASE_OF[w.id] ?? null, currentRoot: root ? basename(root) : null, rootIndex };
    status = { running: true, last: status.last, progress };
  };
  const endStep = (w: Warmable, outcome: WarmOutcome): void => {
    if ((outcome.status === "warmed" || outcome.status === "hit") && PHASE_OF[w.id]) phasesLit.add(PHASE_OF[w.id]);
    progress = { ...progress, done: progress.done + 1, phasesLit: [...phasesLit] };
    status = { running: true, last: status.last, progress };
  };

  for (const w of registry) {
    if (w.scope === "global") {
      beginStep(w, null, 0);
      const outcome = await runOne(w, null, opts);
      outcomes.push(outcome);
      endStep(w, outcome);
    } else {
      for (let i = 0; i < selectedRoots.length; i++) {
        const root = selectedRoots[i];
        beginStep(w, root, i + 1);
        const outcome = w.cost === "llm" && isBusy()
          ? { id: w.id, root, status: "skipped" as const }
          : await runOne(w, root, opts);   // serial: await each before the next
        outcomes.push(outcome);
        endStep(w, outcome);
      }
    }
  }
```

Replace the terminal status write (line 75) with:
```ts
  status = { running: false, last: result, progress: null };
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm build && pnpm exec vitest run dist/warm/__tests__/orchestrator.test.js
```
Expected: PASS (all existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add src/warm/orchestrator.ts src/warm/__tests__/orchestrator.test.ts
git commit -m "$(printf 'feat(warm): publish incremental pass progress\n\nExpose a live WarmProgress snapshot (current phase/project, done/total,\nphases lit) on the warm-status singleton, updated at each warmable\nboundary and cleared when the pass ends. Move PHASE_OF here as the\nsingle source of truth.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: Expose progress on `GET /api/dream/status`

**Files:**
- Modify: `src/dream.controller.ts`
- Test: `src/__tests__/dream.controller.test.ts`

**Interfaces:**
- Consumes: `PHASE_OF`, `WarmProgress`, `getWarmStatus` from Task 1; `runWarmPass` (existing).
- Produces: `/api/dream/status` response now carries `progress: { phase, phasesLit, currentRoot, rootIndex, rootCount, done, total } | null`.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/dream.controller.test.ts` (add imports near the top after the existing `DreamController` import):
```ts
import { runWarmPass, getWarmStatus } from "../warm/orchestrator.js";
import type { Warmable } from "../warm/registry.js";
```
Then, inside `describe("DreamController", ...)`:
```ts
  it("status() surfaces live warm progress mid-pass and null when idle", async () => {
    const c = new DreamController();
    (c as unknown as { base: string }).base = base;

    expect((await c.status()).progress).toBeNull();       // idle

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const reg: Warmable[] = [
      { id: "usage", cost: "cheap", scope: "global", async warm() { return "warmed"; } },
      { id: "analyze", cost: "llm", scope: "per-root", async warm() { await gate; return "warmed"; } },
    ];
    const pass = runWarmPass({ registry: reg, roots: ["/proj"], topN: 1, now: () => 1, isBusy: () => false });
    await new Promise((r) => setTimeout(r, 0));

    const s = await c.status();
    expect(s.progress).not.toBeNull();
    expect(s.progress!.phase).toBe("DEEP");       // analyze running
    expect(s.progress!.currentRoot).toBe("proj");
    expect(s.progress!.total).toBe(2);
    expect(s.progress!.done).toBe(1);

    release();
    await pass;
    expect((await c.status()).progress).toBeNull();  // cleared
  });
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm build && pnpm exec vitest run dist/__tests__/dream.controller.test.js
```
Expected: FAIL — `progress` is not on the status response (schema strips it / property missing).

- [ ] **Step 3: Implement**

In `src/dream.controller.ts`:

Change the orchestrator import (line 10) to add `PHASE_OF`:
```ts
import { getWarmStatus, runWarmPass, PHASE_OF } from "./warm/orchestrator.js";
```

Delete the local `PHASE_OF` const (the three lines: `const PHASE_OF: Record<...> = { usage: "LIGHT", scorecard: "LIGHT", analyze: "DEEP", insights: "REM" };`).

Add a `ProgressSchema` just above `StatusSchema` and extend `StatusSchema`:
```ts
const ProgressSchema = z.object({
  phase: z.enum(["LIGHT", "DEEP", "REM"]).nullable(),
  phasesLit: z.array(z.enum(["LIGHT", "DEEP", "REM"])),
  currentRoot: z.string().nullable(),
  rootIndex: z.number(),
  rootCount: z.number(),
  done: z.number(),
  total: z.number(),
}).nullable();
const StatusSchema = z.object({
  enabled: z.boolean(),
  phasesLit: z.array(z.enum(["LIGHT", "DEEP", "REM"])),
  promoted: z.number(),
  queued: z.number(),
  lastPassAtMs: z.number().nullable(),
  progress: ProgressSchema,
});
```

Replace the `status()` handler body with:
```ts
  async status(): Promise<z.infer<typeof StatusSchema>> {
    const st = getWarmStatus();
    const last = st.last;
    const lit = new Set<"LIGHT" | "DEEP" | "REM">();
    for (const o of last?.outcomes ?? []) {
      if ((o.status === "warmed" || o.status === "hit") && PHASE_OF[o.id]) lit.add(PHASE_OF[o.id]);
    }
    const p = st.progress;
    return {
      enabled: dreamEnabled(this.base),
      phasesLit: [...lit],
      promoted: promotedCount(this.base),
      queued: readQueue(this.base).filter((e) => e.status === "queued").length,
      lastPassAtMs: last?.finishedAt ?? null,
      progress: p ? {
        phase: p.phase, phasesLit: p.phasesLit, currentRoot: p.currentRoot,
        rootIndex: p.rootIndex, rootCount: p.rootCount, done: p.done, total: p.total,
      } : null,
    };
  }
```

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm build && pnpm exec vitest run dist/__tests__/dream.controller.test.js
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dream.controller.ts src/__tests__/dream.controller.test.ts
git commit -m "$(printf 'feat(dream): surface live warm progress on /api/dream/status\n\nFold the orchestrator WarmProgress snapshot into the dream status\nresponse and share the PHASE_OF mapping instead of a local copy.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 3: Frontend type + `DreamProgress` component + CSS

**Files:**
- Modify: `packages/console/src/panels/Dreaming/api.ts`
- Create: `packages/console/src/panels/Dreaming/DreamProgress.tsx`
- Create: `packages/console/src/panels/Dreaming/DreamProgress.test.tsx`
- Modify: `packages/console/src/shell/theme.css`

**Interfaces:**
- Consumes: the `/api/dream/status` `progress` shape from Task 2.
- Produces: `export interface DreamProgressData {...}`, `DreamStatus.progress: DreamProgressData | null`, and `export function DreamProgress({ progress }: { progress: DreamProgressData | null }): ReactElement | null`.

- [ ] **Step 1: Add the type to `api.ts`**

In `packages/console/src/panels/Dreaming/api.ts`, replace the `DreamStatus` interface (line 1) with:
```ts
export interface DreamProgressData {
  phase: "LIGHT" | "DEEP" | "REM" | null;
  phasesLit: Array<"LIGHT" | "DEEP" | "REM">;
  currentRoot: string | null;
  rootIndex: number;
  rootCount: number;
  done: number;
  total: number;
}
export interface DreamStatus { enabled: boolean; phasesLit: Array<"LIGHT" | "DEEP" | "REM">; promoted: number; queued: number; lastPassAtMs: number | null; progress: DreamProgressData | null }
```

- [ ] **Step 2: Write the failing component test**

Create `packages/console/src/panels/Dreaming/DreamProgress.test.tsx`:
```tsx
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { DreamProgress } from "./DreamProgress.js";

afterEach(cleanup);

describe("DreamProgress", () => {
  it("renders nothing when idle", () => {
    const { container } = render(<DreamProgress progress={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows phase states and the current project", () => {
    render(<DreamProgress progress={{ phase: "DEEP", phasesLit: ["LIGHT"], currentRoot: "my-app", rootIndex: 2, rootCount: 5, done: 3, total: 8 }} />);
    const phases = screen.getAllByRole("listitem");
    expect(phases.find((li) => li.textContent === "LIGHT")!.getAttribute("data-state")).toBe("done");
    expect(phases.find((li) => li.textContent === "DEEP")!.getAttribute("data-state")).toBe("running");
    expect(phases.find((li) => li.textContent === "REM")!.getAttribute("data-state")).toBe("pending");
    expect(screen.getByText("my-app")).toBeTruthy();
    expect(screen.getByText(/2 of 5/)).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

```bash
cd /Users/rfeng/Projects/ninemind/agentgem-worktrees/dream-progress
pnpm --filter @agentgem/console exec vitest run src/panels/Dreaming/DreamProgress.test.tsx
```
Expected: FAIL — `DreamProgress.tsx` does not exist.

- [ ] **Step 4: Implement the component**

Create `packages/console/src/panels/Dreaming/DreamProgress.tsx`:
```tsx
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import type { ReactElement } from "react";
import type { DreamProgressData } from "./api.js";

const PHASES = ["LIGHT", "DEEP", "REM"] as const;

/** Live step tracker for a running warm pass: the three sleep phases
 *  (done / running / pending) plus the current project. Renders nothing when
 *  idle. Phases may not flip strictly top-to-bottom (the registry runs REM
 *  before DEEP); the "now" line is the source of truth for what's executing. */
export function DreamProgress({ progress }: { progress: DreamProgressData | null }): ReactElement | null {
  if (!progress) return null;
  const stateOf = (p: (typeof PHASES)[number]): "running" | "done" | "pending" =>
    progress.phase === p ? "running" : progress.phasesLit.includes(p) ? "done" : "pending";
  return (
    <div className="dream-progress" role="status" aria-live="polite">
      <ul className="dream-progress-phases">
        {PHASES.map((p) => (
          <li key={p} className="dream-progress-phase" data-state={stateOf(p)}>
            <span className="dream-progress-dot" aria-hidden="true" />
            {p}
          </li>
        ))}
      </ul>
      {progress.currentRoot && (
        <p className="dream-progress-now">
          now: <strong>{progress.currentRoot}</strong>
          {progress.rootCount > 1 && progress.rootIndex > 0 ? ` (${progress.rootIndex} of ${progress.rootCount})` : ""}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Run to verify it passes**

```bash
pnpm --filter @agentgem/console exec vitest run src/panels/Dreaming/DreamProgress.test.tsx
```
Expected: PASS.

- [ ] **Step 6: Add the CSS**

In `packages/console/src/shell/theme.css`, after the `.dream-scene .dream-btn { margin-left: auto; }` rule (~line 1677), append:
```css
.dream-progress { display: flex; align-items: center; gap: 14px; flex: 1 1 auto; flex-wrap: wrap; }
.dream-progress-phases { display: flex; gap: 6px; list-style: none; margin: 0; padding: 0; }
.dream-progress-phase { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px;
  font: 600 10.5px/1 var(--font-mono); letter-spacing: .09em; border: 1px solid var(--line); color: var(--ink-soft); background: var(--raised); }
.dream-progress-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--line); flex: none; }
.dream-progress-phase[data-state="done"] { color: var(--emerald); border-color: rgba(47, 107, 58, .32); }
.dream-progress-phase[data-state="done"] .dream-progress-dot { background: var(--emerald); }
.dream-progress-phase[data-state="running"] { color: var(--accent); border-color: var(--accent); box-shadow: var(--shadow-sm); }
.dream-progress-phase[data-state="running"] .dream-progress-dot { background: var(--accent); animation: warming-pulse 1.5s ease-in-out infinite; }
.dream-progress-now { margin: 0; color: var(--ink-soft); font: 13px/1.4 var(--font-ui); }
.dream-progress-now strong { color: var(--ink); font-weight: 600; }
@media (prefers-reduced-motion: reduce) { .dream-progress-phase[data-state="running"] .dream-progress-dot { animation: none; } }
```

Verify: `grep -c "dream-progress" packages/console/src/shell/theme.css` → must be > 0.

- [ ] **Step 7: Commit**

```bash
git add packages/console/src/panels/Dreaming/api.ts packages/console/src/panels/Dreaming/DreamProgress.tsx packages/console/src/panels/Dreaming/DreamProgress.test.tsx packages/console/src/shell/theme.css
git commit -m "$(printf 'feat(console): DreamProgress live step tracker + styles\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 4: Wire live progress into the Journey panel

**Files:**
- Modify: `packages/console/src/panels/Dreaming/index.tsx`
- Test: `packages/console/src/panels/Dreaming/Dreaming.test.tsx`

**Interfaces:**
- Consumes: `DreamProgress` (Task 3), `getStatus`/`getJourney`/`post` (existing `api.ts`), `DreamStatus.progress` (Task 3).
- Behavior: `Dream now` gives instant optimistic `Dreaming…`; an adaptive poll reflects the real running pass (`status.progress`) and clears the optimistic flag when the server confirms a run or a new pass lands; the timeline auto-refreshes on completion. The static `.phases` pills show only when idle; `DreamProgress` shows while running.

- [ ] **Step 1: Update the two affected tests + add a progress test**

In `packages/console/src/panels/Dreaming/Dreaming.test.tsx`:

**(a)** Replace the last test (the `"polls until a new pass lands, shows a 'complete' note…"` test, lines 233–244) with:
```ts
  it("re-enables the button once a new pass lands (optimistic pending clears)", async () => {
    let ran = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/api/dream/status")) return new Response(JSON.stringify({ enabled: true, phasesLit: ["DEEP"], promoted: 2, queued: 1, lastPassAtMs: ran ? 2 : 1, progress: null }));
      if (url.endsWith("/api/dream/run")) { ran = true; return new Response(JSON.stringify({ started: true })); }
      if (url.includes("/api/journey")) return new Response(JSON.stringify({ events: [], truncated: false }));
      return new Response(JSON.stringify({ ok: true }));
    }));
    render(<Dreaming apiBase="" />);
    fireEvent.click(await screen.findByRole("button", { name: "Dream now" }));
    await screen.findByRole("button", { name: /dreaming/i });                 // instant optimistic feedback
    await waitFor(() => expect(screen.getByRole("button", { name: "Dream now" })).toBeTruthy(), { timeout: 4000 }); // pass landed → re-enabled
  });
```

**(b)** Add a new test after it:
```ts
  it("shows the live step tracker while a pass reports progress", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/api/dream/status")) return new Response(JSON.stringify({ enabled: true, phasesLit: [], promoted: 0, queued: 0, lastPassAtMs: null, progress: { phase: "DEEP", phasesLit: ["LIGHT"], currentRoot: "my-app", rootIndex: 2, rootCount: 5, done: 3, total: 8 } }));
      if (url.includes("/api/journey")) return new Response(JSON.stringify({ events: [], truncated: false }));
      return new Response(JSON.stringify({ ok: true }));
    }));
    render(<Dreaming apiBase="" />);
    await waitFor(() => expect(screen.getByText("my-app")).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/2 of 5/)).toBeTruthy());
  });
```

- [ ] **Step 2: Run to verify the new tests fail**

```bash
pnpm --filter @agentgem/console exec vitest run src/panels/Dreaming/Dreaming.test.tsx
```
Expected: FAIL — the new progress test finds no `my-app` (index.tsx doesn't render `DreamProgress` yet); the re-enable test may fail on the old note logic.

- [ ] **Step 3: Rewrite `index.tsx`**

In `packages/console/src/panels/Dreaming/index.tsx`:

Add the import (next to the other `./` imports at the top):
```ts
import { DreamProgress } from "./DreamProgress.js";
```

Replace the state block inside `Dreaming` (the `const [running, setRunning] = useState(false);` and `const [note, setNote] = useState<string | null>(null);` lines) with:
```ts
  const [pending, setPending] = useState(false);
  const aliveRef = useRef(true);
  const passAtClickRef = useRef<number | null>(null);
  const lastSeenPassRef = useRef<number | null>(null);
```
(Keep the existing `useEffect(() => () => { aliveRef.current = false; }, []);` — remove the now-duplicate `aliveRef` declaration if it was separate; there must be exactly one `aliveRef`.)

Add this adaptive poll effect immediately after the existing `useEffect(() => { refresh(); }, [refresh]);`:
```ts
  // Adaptive live poll: fast while a pass runs so the step tracker updates,
  // slow when idle. Clears the optimistic `pending` flag once the server shows a
  // running pass or a pass completes, and refreshes the timeline on completion.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const s = await getStatus(apiBase).catch(() => null);
      if (!aliveRef.current) return;
      if (s) {
        setStatus(s);
        if (s.progress) setPending(false);
        if (s.lastPassAtMs != null && s.lastPassAtMs !== passAtClickRef.current) setPending(false);
        if (s.lastPassAtMs != null && s.lastPassAtMs !== lastSeenPassRef.current) {
          lastSeenPassRef.current = s.lastPassAtMs;
          getJourney(apiBase, filter === "all" ? undefined : filter)
            .then((r) => { if (aliveRef.current) { setEvents(r.events); setTruncated(r.truncated); } })
            .catch(() => {});
        }
      }
      if (aliveRef.current) timer = setTimeout(tick, s?.progress || pending ? 1200 : 6000);
    };
    void tick();
    return () => { clearTimeout(timer); };
  }, [apiBase, filter, pending]);
```

Replace the entire `runDream` callback (from `const runDream = useCallback(async () => {` through its closing `}, [apiBase, status, filter]);`) with:
```ts
  // Fire-and-forget on the server; give instant optimistic feedback, then let the
  // adaptive poll reflect the real running pass and clear `pending` when the
  // server confirms progress or a new pass lands.
  const runDream = useCallback(async () => {
    setError(null);
    passAtClickRef.current = status?.lastPassAtMs ?? null;
    setPending(true);
    try {
      await post(apiBase, "run");
      const s = await getStatus(apiBase).catch(() => null);
      if (s && aliveRef.current) setStatus(s);
    } catch {
      if (aliveRef.current) { setError("Dream run failed."); setPending(false); }
    }
  }, [apiBase, status]);
```

In the render, replace the `<section className="dream-scene">…</section>` block with:
```tsx
      {status && (
        <section className="dream-scene">
          {status.progress
            ? <DreamProgress progress={status.progress} />
            : <div className="phases">{PHASES.map((p) => <span key={p} data-lit={status.phasesLit.includes(p)}>{p}</span>)}</div>}
          <p className="dream-counts">{status.promoted} promoted · {status.queued} queued</p>
          <button className="dream-btn" disabled={pending || !!status.progress} onClick={runDream}>{pending || status.progress ? "Dreaming…" : "Dream now"}</button>
        </section>
      )}
```

Delete the note render line: `{note && <p className="dream-counts" role="status">{note}</p>}`.

- [ ] **Step 4: Run to verify the tests pass**

```bash
pnpm --filter @agentgem/console exec vitest run src/panels/Dreaming/Dreaming.test.tsx
```
Expected: PASS (all, including the two updated/added).

- [ ] **Step 5: Typecheck the console**

```bash
pnpm --filter @agentgem/console exec tsc --noEmit
```
Expected: no errors (progress field, DreamProgress import all resolve).

- [ ] **Step 6: Browser verification**

```bash
# Build, then run on a FREE port (NEVER 4317 — a stale worktree server may hold it).
pnpm build
AGENTGEM_WARM_INTERVAL_MS=15000 PORT=4319 node dist/index.js   # short idle interval to trigger an auto pass
```
In a browser (or browser-harness) open `http://localhost:4319/#/dreaming`:
- Click **Dream now** → button shows `Dreaming…` instantly; within ~1–2s the `DreamProgress` panel appears with phase chips + a `now: <project> (i of n)` line; the timeline refreshes when the pass completes.
- Wait for an auto pass (idle interval) → the panel lights up **without** clicking.
Stop the server (Ctrl-C) when done.

- [ ] **Step 7: Commit**

```bash
git add packages/console/src/panels/Dreaming/index.tsx packages/console/src/panels/Dreaming/Dreaming.test.tsx
git commit -m "$(printf 'feat(console): live Dreaming progress in the Journey scene\n\nAdaptive status poll drives the DreamProgress step tracker for manual and\nauto passes; optimistic pending keeps instant Dream-now feedback; timeline\nauto-refreshes on completion.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 5: Add the current phase to the `WarmingPill`

**Files:**
- Modify: `packages/console/src/components/WarmingPill.tsx`
- Test: `packages/console/src/components/WarmingPill.test.tsx`
- Modify: `packages/console/src/shell/theme.css`

**Interfaces:**
- Consumes: `/api/warm/status` now returns `progress: { phase } | null` (Task 1, served verbatim by `appCommon.ts`).

- [ ] **Step 1: Write the failing test**

Append to `packages/console/src/components/WarmingPill.test.tsx` inside `describe("WarmingPill", ...)`:
```ts
  it("appends the current phase when a pass reports progress", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ running: true, progress: { phase: "DEEP" }, last: null })));
    render(<WarmingPill apiBase="" />);
    await waitFor(() => expect(screen.getByText("DEEP")).toBeTruthy());
    expect(screen.getByText("warming…")).toBeTruthy();
  });
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @agentgem/console exec vitest run src/components/WarmingPill.test.tsx
```
Expected: FAIL — no `DEEP` text (component ignores progress).

- [ ] **Step 3: Implement**

Replace the body of `packages/console/src/components/WarmingPill.tsx` (keep the header) with:
```tsx
import { type ReactElement, useEffect, useState } from "react";

interface WarmStatus { running: boolean; progress: { phase: string | null } | null; last: { finishedAt: number } | null }

export function WarmingPill({ apiBase }: { apiBase: string }): ReactElement | null {
  const [state, setState] = useState<{ running: boolean; phase: string | null }>({ running: false, phase: null });
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch(`${apiBase}/api/warm/status`);
        if (!r.ok) return;
        const s = (await r.json()) as WarmStatus;
        if (alive) setState({ running: s.running, phase: s.progress?.phase ?? null });
      } catch { /* best-effort */ }
    };
    void poll();
    const h = setInterval(poll, 5000);
    return () => { alive = false; clearInterval(h); };
  }, [apiBase]);
  if (!state.running) return null;
  return (
    <span className="warming-pill" title="Precomputing insights in the background">
      <span className="warming-pill__spark" aria-hidden="true">✦</span>
      warming…{state.phase ? <span className="warming-pill__phase">{state.phase}</span> : null}
    </span>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm --filter @agentgem/console exec vitest run src/components/WarmingPill.test.tsx
```
Expected: PASS (all three — the two existing tests still pass because `progress` is absent → `phase` null → plain `warming…`).

- [ ] **Step 5: Add the CSS**

In `packages/console/src/shell/theme.css`, after the `.warming-pill__spark { ... }` rule (~line 165), append:
```css
.warming-pill__phase { margin-left: 5px; font: 600 9.5px/1 var(--font-mono); letter-spacing: .08em; opacity: .85; }
```
Verify: `grep -c "warming-pill__phase" packages/console/src/shell/theme.css` → must be > 0.

- [ ] **Step 6: Commit**

```bash
git add packages/console/src/components/WarmingPill.tsx packages/console/src/components/WarmingPill.test.tsx packages/console/src/shell/theme.css
git commit -m "$(printf 'feat(console): show current phase on the warming pill\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Final verification (after all tasks)

- [ ] **Root suite (CI mirror):** `pnpm build && pnpm exec vitest run dist` → all green.
- [ ] **Console suite (local, not in CI):** `pnpm --filter @agentgem/console exec vitest run` → all green.
- [ ] **Console typecheck:** `pnpm --filter @agentgem/console exec tsc --noEmit` → clean.
- [ ] Open a PR against `main`; CI must pass `test (24)` before merge (rebase-merge).

## Self-Review (completed while writing)

- **Spec coverage:** live stepper → Task 1 (backend progress); 3 phases + current project → Task 1 shape + Task 3 component; manual + auto passes → Task 4 adaptive poll reads `status.progress` regardless of trigger + Task 5 pill; poll not SSE → Tasks 4/5; event-loop-boundary honesty → begin/end-step publish at boundaries + component comment; tests → each task is TDD; CSS-enforced classes → Tasks 3/5 add rules + grep check.
- **Placeholder scan:** none — every step has concrete code/commands.
- **Type consistency:** `WarmProgress`/`DreamProgressData` fields match across orchestrator → controller → api.ts → component; `PHASE_OF` exported once (Task 1) and imported (Task 2); `progress` nullable end-to-end.
- **Known behavior change flagged:** the old "Dream pass complete." note and the fixed 12×1.5s loop are removed; the completion test is rewritten accordingly (Task 4 Step 1a).
