# Background Report Runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agent-backed report generation (Insights, Rubric, Analyze) survive navigation, notify on completion, and be visible/re-attachable from a cross-app activity view — with the smallest diff over what already works.

**Architecture (lightweight — revised after eng review):** The existing report SSE routes already keep computing and cache their result after a client disconnects. So we do NOT take over running them. We add a small in-memory **`ReportRegistry`** that those routes update on start/phase/done/failed, expose `GET /api/report/runs` over it, and build an `ActivityProvider` + activity menu + notify-on-done on top. A `useReportRun` client hook drives each panel's **existing** stream opener, reattaches the latest run of its kind on mount, and refuses to open a second stream for a run already in flight (avoiding double-compute). No queue, no manager, no new streaming endpoint, no concurrency change.

**Tech Stack:** TypeScript, Node, Express (raw routes on `server.expressApp`), React 18, native `EventSource`/`fetch`, Vitest.

## Why this shape (eng-review decisions)

- **Rejected** a `ReportRunManager` that owns runs in a global serial queue + a new re-attachable SSE view. It was a concurrency *regression* (today the three report kinds run concurrently; a queue serializes them and a wedged run would block all reports with no cancel), and the new SSE view added nothing on reattach (which is status-only) over polling. See `../specs/2026-07-13-background-report-runs-design.md`.
- **Reattach = latest run of the kind** (not a specific per-params run). Simpler; the server registry is already reload-proof. Precise per-run reattach (localStorage pointer + selected-row persistence) is deferred.
- **Scope: insights, rubric, analyze** — the three agent-backed reports whose routes emit a `done` report. Scorecard (not agent-backed; already SWR) and gem-run (an execution, no report payload) are out of scope.

## Global Constraints

- **Concurrency: unchanged from today.** Report runs are NOT serialized. Different kinds/params run concurrently exactly as they do now. The existing `beginForeground()/endForeground()` bracketing on the routes stays as-is.
- **Persistence:** in-memory registry only (survives navigation + reload since it lives in the server process; a full restart drops in-flight state, which the result cache re-serves).
- **Do NOT edit the compute cores** (`computeInsights`/`computeRubric`/`computeWorkflowAnalysis`) or delete any existing route. The existing `/api/insights/stream`, `/api/rubric/stream`, `/api/workflow/analyze/stream` stay and keep working for direct callers.
- **ID / keys:** a run is identified by `${kind}:${paramsKey}`. `paramsKey` is derived per kind from the route's query (`insights`/`analyze` = `root`; `rubric` = `` `${rubric}:${scope}:${root ?? ""}:${sessionId ?? ""}` ``).
- **SSE writer idiom (existing, unchanged):** `res.write(\`event: ${e}\n\`); res.write(\`data: ${JSON}\n\n\`)`.
- **Logger:** `import { createLogger } from "@agentgem/base"`.
- **Console tests are NOT in CI** — run locally. Root `src/**/__tests__` tests ARE CI-gated (`test (24)`).
- **Console has no CSS framework:** every new class needs a hand-authored rule (Task 4 CSS step). Verify UI in a real browser.
- **Ship in two PRs:** PR1 = Tasks 1–6 (core + Insights proof). PR2 = Tasks 7–9 (Rubric + Analyze). Each off freshly-fetched `origin/main`.

## Data flow

```
INITIAL WATCH (unchanged):
  panel.start(key, params) ─▶ openInsightsStream(...) ─▶ GET /api/insights/stream
                                                            │ route: registry.begin(insights,key)
                                                            │ computeInsights(progress.onPhase → registry.phase)
   panel folds phase/delta/done into its own state ◀───────┤ done → registry.finish(done); failed → finish(failed)
   navigate away: es.close() ─ compute continues + caches ─┘ (registry.finish still runs after the await)

NOTIFY + ACTIVITY:
  ActivityProvider ─ poll GET /api/report/runs (5s) ─▶ registry.list()
    └─ detectReportDone(prev,next) ─▶ toast + osNotify   |   ActivityMenu renders the list, deep-links

REATTACH (come back):
  panel mount ─▶ GET /api/report/runs ─▶ latest of kind
     ├─ running → poll /runs until done, THEN openStream(fresh=false) once (cache hit) → report
     ├─ done    → openStream(fresh=false) once (cache hit) → report
     └─ failed  → show error from the record
  panel.start on an already-running key → attach+poll instead of opening a 2nd stream (no double-compute)
```

---

### Task 1: `ReportRegistry` (server)

In-memory tracker of report runs. Pure data structure; the routes drive it in Task 2.

**Files:**
- Create: `src/report/registry.ts`
- Test: `src/report/__tests__/registry.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type RunStatus = "running" | "done" | "failed";
  interface RunRecord { kind: string; paramsKey: string; params: Record<string, string>; status: RunStatus; phase: string; startedAt: number; finishedAt?: number; error?: string }
  interface RunSummary { id: string; kind: string; paramsKey: string; params: Record<string, string>; status: RunStatus; phase: string; startedAt: number; finishedAt?: number; error?: string }
  class ReportRegistry {
    constructor(opts?: { now?: () => number; ttlMs?: number; maxDone?: number });
    begin(kind: string, paramsKey: string, params: Record<string, string>): void;
    phase(kind: string, paramsKey: string, phase: string): void;
    finish(kind: string, paramsKey: string, status: "done" | "failed", error?: string): void;
    get(kind: string, paramsKey: string): RunRecord | undefined;
    list(): RunSummary[];   // newest first; id = `${kind}:${paramsKey}`
    sweep(): void;
  }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// src/report/__tests__/registry.test.ts
import { describe, it, expect } from "vitest";
import { ReportRegistry } from "../registry.js";

describe("ReportRegistry", () => {
  it("begin marks a run running and list() exposes it newest-first", () => {
    let t = 100;
    const r = new ReportRegistry({ now: () => t });
    r.begin("insights", "/a", { root: "/a" });
    t = 200;
    r.begin("rubric", "x:all::", { rubric: "x", scope: "all" });
    const list = r.list();
    expect(list.map((x) => x.kind)).toEqual(["rubric", "insights"]);   // newest first
    expect(list[1]).toMatchObject({ id: "insights:/a", status: "running", params: { root: "/a" } });
  });

  it("phase updates the running record", () => {
    const r = new ReportRegistry();
    r.begin("insights", "/a", { root: "/a" });
    r.phase("insights", "/a", "judging");
    expect(r.get("insights", "/a")?.phase).toBe("judging");
  });

  it("finish records terminal status + finishedAt, and a re-begin restarts it", () => {
    let t = 1;
    const r = new ReportRegistry({ now: () => t });
    r.begin("insights", "/a", { root: "/a" });
    t = 5; r.finish("insights", "/a", "done");
    expect(r.get("insights", "/a")).toMatchObject({ status: "done", finishedAt: 5 });
    t = 9; r.begin("insights", "/a", { root: "/a" });   // Re-run
    expect(r.get("insights", "/a")).toMatchObject({ status: "running", startedAt: 9, finishedAt: undefined });
  });

  it("finish with an error message records it as failed", () => {
    const r = new ReportRegistry();
    r.begin("rubric", "k", { rubric: "r" });
    r.finish("rubric", "k", "failed", "adapter timeout");
    expect(r.get("rubric", "k")).toMatchObject({ status: "failed", error: "adapter timeout" });
  });

  it("sweep evicts finished runs past the TTL but keeps running ones", () => {
    let t = 1000;
    const r = new ReportRegistry({ now: () => t, ttlMs: 100 });
    r.begin("insights", "/done", { root: "/done" });
    r.finish("insights", "/done", "done");
    r.begin("insights", "/live", { root: "/live" });   // still running
    t = 2000;
    r.sweep();
    expect(r.get("insights", "/done")).toBeUndefined();
    expect(r.get("insights", "/live")).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/rfeng/Projects/ninemind/agentgem-worktrees/async-report-runs && npx vitest run src/report/__tests__/registry.test.ts`
Expected: FAIL — `Cannot find module '../registry.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/report/registry.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// In-memory tracker of agent-backed report runs (insights | rubric | analyze).
// The existing SSE routes drive it (begin/phase/finish); it exists only to power
// the activity view + notify-on-done and to let a returning panel discover a run.
// The RESULT is never stored here — the compute cores' own cache holds it, and a
// reattaching panel re-opens the existing stream (a cache hit) to load it.
import { createLogger } from "@agentgem/base";

const log = createLogger("report-registry");

export type RunStatus = "running" | "done" | "failed";

export interface RunRecord {
  kind: string;
  paramsKey: string;
  params: Record<string, string>;   // the route query, so a reattach can rebuild the stream
  status: RunStatus;
  phase: string;
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

export interface RunSummary extends RunRecord { id: string }

export class ReportRegistry {
  private runs = new Map<string, RunRecord>();   // key = `${kind}:${paramsKey}`
  private now: () => number;
  private ttlMs: number;
  private maxDone: number;

  constructor(opts: { now?: () => number; ttlMs?: number; maxDone?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? 30 * 60_000;
    this.maxDone = opts.maxDone ?? 50;
  }

  private key(kind: string, paramsKey: string): string { return `${kind}:${paramsKey}`; }

  begin(kind: string, paramsKey: string, params: Record<string, string>): void {
    this.runs.set(this.key(kind, paramsKey), { kind, paramsKey, params, status: "running", phase: "starting", startedAt: this.now() });
  }

  phase(kind: string, paramsKey: string, phase: string): void {
    const r = this.runs.get(this.key(kind, paramsKey));
    if (r && r.status === "running") r.phase = phase;
  }

  finish(kind: string, paramsKey: string, status: "done" | "failed", error?: string): void {
    const r = this.runs.get(this.key(kind, paramsKey));
    if (!r) return;
    r.status = status; r.finishedAt = this.now();
    if (status === "done") r.phase = "done";
    if (error) r.error = error;
  }

  get(kind: string, paramsKey: string): RunRecord | undefined { return this.runs.get(this.key(kind, paramsKey)); }

  list(): RunSummary[] {
    return [...this.runs.entries()]
      .map(([id, r]) => ({ id, ...r }))
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, r] of this.runs) {
      if (r.status !== "running" && r.finishedAt != null && r.finishedAt < cutoff) this.runs.delete(id);
    }
    const finished = [...this.runs.entries()]
      .filter(([, r]) => r.status !== "running")
      .sort((a, b) => (a[1].finishedAt ?? 0) - (b[1].finishedAt ?? 0));
    while (finished.length > this.maxDone) this.runs.delete(finished.shift()![0]);
    log.debug("swept; %d runs retained", this.runs.size);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/report/__tests__/registry.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/report/registry.ts src/report/__tests__/registry.test.ts
git commit -m "feat(report): in-memory ReportRegistry for run tracking"
```

---

### Task 2: Route tracking + `GET /api/report/runs`

Thread a small `track` object into the three stream functions so they report lifecycle to the registry, and expose the list route. `track` is optional, so existing tests keep passing.

**Files:**
- Modify: `src/insightsStream.ts`, `src/rubricStream.ts`, `src/workflowStream.ts` (add an optional `track` param + calls)
- Modify: `src/appCommon.ts` (create registry, build a tracker per request, wrap the 3 routes, register `GET /api/report/runs`, periodic sweep)
- Create: `src/report/track.ts` (the `RunTracker` type + a `makeTracker(registry, kind, paramsKey, params)` helper)
- Test: `src/report/__tests__/track.test.ts`

**Interfaces:**
- Consumes: `ReportRegistry` (Task 1).
- Produces:
  ```ts
  interface RunTracker { phase(p: string): void; done(): void; failed(msg: string): void }
  function makeTracker(reg: ReportRegistry, kind: string, paramsKey: string, params: Record<string,string>): RunTracker;
  function insightsParamsKey(q: Record<string, unknown>): string;   // root
  function rubricParamsKey(q: Record<string, unknown>): string;     // `${rubric}:${scope}:${root??""}:${sessionId??""}`
  function analyzeParamsKey(q: Record<string, unknown>): string;    // root
  // streamInsights/streamRubric/streamWorkflowAnalyze gain an optional 3rd arg `track?: RunTracker`.
  ```

- [ ] **Step 1: Write the failing test**

```ts
// src/report/__tests__/track.test.ts
import { describe, it, expect } from "vitest";
import { ReportRegistry } from "../registry.js";
import { makeTracker, insightsParamsKey, rubricParamsKey } from "../track.js";

describe("makeTracker", () => {
  it("registers begin on creation and forwards phase/done to the registry", () => {
    const reg = new ReportRegistry();
    const t = makeTracker(reg, "insights", "/a", { root: "/a" });
    expect(reg.get("insights", "/a")?.status).toBe("running");
    t.phase("judging");
    expect(reg.get("insights", "/a")?.phase).toBe("judging");
    t.done();
    expect(reg.get("insights", "/a")?.status).toBe("done");
  });

  it("forwards failed with the message", () => {
    const reg = new ReportRegistry();
    const t = makeTracker(reg, "rubric", "k", { rubric: "r" });
    t.failed("boom");
    expect(reg.get("rubric", "k")).toMatchObject({ status: "failed", error: "boom" });
  });
});

describe("paramsKey derivation", () => {
  it("insights key is the root", () => {
    expect(insightsParamsKey({ root: "/proj" })).toBe("/proj");
  });
  it("rubric key composes rubric:scope:root:sessionId", () => {
    expect(rubricParamsKey({ rubric: "hygiene", scope: "project", root: "/p" })).toBe("hygiene:project:/p:");
    expect(rubricParamsKey({ rubric: "hygiene", scope: "all" })).toBe("hygiene:all::");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/report/__tests__/track.test.ts`
Expected: FAIL — `Cannot find module '../track.js'`.

- [ ] **Step 3: Write `src/report/track.ts`**

```ts
// src/report/track.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Bridges an SSE report route to the ReportRegistry. makeTracker() marks the run
// running immediately (begin), then the route forwards phase/done/failed. The
// terminal calls run AFTER the route's awaited compute settles, so they record
// correctly even when the client disconnected mid-run (background completion).
import type { ReportRegistry } from "./registry.js";

export interface RunTracker { phase(p: string): void; done(): void; failed(msg: string): void }

export function makeTracker(reg: ReportRegistry, kind: string, paramsKey: string, params: Record<string, string>): RunTracker {
  reg.begin(kind, paramsKey, params);
  return {
    phase: (p) => reg.phase(kind, paramsKey, p),
    done: () => reg.finish(kind, paramsKey, "done"),
    failed: (msg) => reg.finish(kind, paramsKey, "failed", msg),
  };
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function insightsParamsKey(q: Record<string, unknown>): string { return str(q.root); }
export function analyzeParamsKey(q: Record<string, unknown>): string { return str(q.root); }
export function rubricParamsKey(q: Record<string, unknown>): string {
  const scope = str(q.scope) || "project";
  return `${str(q.rubric)}:${scope}:${str(q.root)}:${str(q.sessionId)}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/report/__tests__/track.test.ts`
Expected: PASS (4 assertions across 4 tests).

- [ ] **Step 5: Thread `track` into `src/insightsStream.ts`**

Change the signature and the three lifecycle points (the compute progress, the done send, the failed send). Full new file:

```ts
// src/insightsStream.ts  (SPDX header unchanged)
import { computeInsights } from "./insightsCore.js";
import type { RunTracker } from "./report/track.js";

interface SseReq { query: Record<string, unknown> }
interface SseRes {
  writeHead(status: number, headers: Record<string, string>): void;
  write(chunk: string): void;
  end(): void;
}

export async function streamInsights(req: SseReq, res: SseRes, track?: RunTracker): Promise<void> {
  const root = typeof req.query.root === "string" ? req.query.root : "";
  const dir = typeof req.query.dir === "string" ? req.query.dir : undefined;
  const fresh = req.query.fresh === "1";

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  const send = (event: string, data: unknown) => { res.write(`event: ${event}\n`); res.write(`data: ${JSON.stringify(data)}\n\n`); };

  try {
    if (!root) { send("failed", { message: "missing root" }); track?.failed("missing root"); return; }
    const { payload, cached, updatedAt } = await computeInsights(root, {
      dir, force: fresh,
      progress: {
        onPhase: (phase, extra) => { send("phase", { phase, ...(extra ?? {}) }); track?.phase(extra?.sessions != null ? `${phase} (${extra.sessions} sessions)` : phase); },
        onDelta: (text) => send("delta", { text }),
      },
    });
    send("done", { ...payload, cached, updatedAt });
    track?.done();
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    send("failed", { message: msg });
    track?.failed(msg);
  } finally {
    res.end();
  }
}
```

- [ ] **Step 6: Thread `track` into `src/rubricStream.ts` and `src/workflowStream.ts` (same pattern)**

For each: add `track?: RunTracker` as the last param; call `track?.phase(...)` inside the `onPhase`/`onDelta` progress (rubric has only `onDelta` — call `track?.phase("evaluating")` once right before `computeRubric`, since rubric has no phase callback); call `track?.done()` right after the `send("done", ...)`; and in every early-return `send("failed", ...)` and the `catch`, add `track?.failed(msg)`. Do not change any other logic. (Rubric's multiple early `send("failed", ...)` guards each get a paired `track?.failed(<same message>)`.)

- [ ] **Step 7: Wire the registry + routes in `src/appCommon.ts`**

Add imports near the warm/originGuard imports (~line 53–56):
```ts
import { ReportRegistry } from "./report/registry.js";
import { makeTracker, insightsParamsKey, rubricParamsKey, analyzeParamsKey } from "./report/track.js";
```

Replace the three existing route registrations (`/api/insights/stream` line 253, `/api/rubric/stream` line 261, `/api/workflow/analyze/stream` line 238) so each builds a tracker and passes it. First, just before them, create the registry:
```ts
  // Report activity registry: the three agent-backed report routes record their
  // run lifecycle here so the console can notify-on-done and show what is running.
  // In-memory; swept for TTL. The compute + cache are untouched — this only tracks.
  const reportRegistry = new ReportRegistry();
  setInterval(() => reportRegistry.sweep(), 60_000).unref();
  server.expressApp.get("/api/report/runs", originGuard, (_req, res) => res.json({ runs: reportRegistry.list() } as never));
```
Then the three wrapped routes:
```ts
  server.expressApp.get("/api/workflow/analyze/stream", originGuard, async (req, res) => {
    const track = makeTracker(reportRegistry, "analyze", analyzeParamsKey(req.query as never), req.query as never);
    beginForeground();
    try { await streamWorkflowAnalyze(req as never, res as never, track); } finally { endForeground(); }
  });
  server.expressApp.get("/api/insights/stream", originGuard, async (req, res) => {
    const track = makeTracker(reportRegistry, "insights", insightsParamsKey(req.query as never), req.query as never);
    beginForeground();
    try { await streamInsights(req as never, res as never, track); } finally { endForeground(); }
  });
  server.expressApp.get("/api/rubric/stream", originGuard, async (req, res) => {
    const track = makeTracker(reportRegistry, "rubric", rubricParamsKey(req.query as never), req.query as never);
    beginForeground();
    try { await streamRubric(req as never, res as never, track); } finally { endForeground(); }
  });
```
Note: `makeTracker` calls `registry.begin` synchronously, so a run shows `running` the instant the route is hit — before the first `await`. The `track.done()/failed()` calls inside the stream functions run after the awaited compute settles, so background completion (client gone) still records correctly.

- [ ] **Step 8: Typecheck + tests (incl. existing stream tests still green)**

Run: `npm run build && npx vitest run src/report src/__tests__`
Expected: build PASS; new report tests PASS; existing insights/rubric/workflow stream tests still PASS (track is optional).

- [ ] **Step 9: Commit**

```bash
git add src/report/track.ts src/report/__tests__/track.test.ts src/insightsStream.ts src/rubricStream.ts src/workflowStream.ts src/appCommon.ts
git commit -m "feat(report): stream routes report lifecycle to the registry + /api/report/runs"
```

---

### Task 3: `useReportRun` client hook

Drives a panel's existing stream opener; reattaches the latest run of its kind on mount; refuses to open a second stream for a key already in flight.

**Files:**
- Create: `packages/console/src/report/useReportRun.ts`
- Test: `packages/console/src/report/__tests__/useReportRun.test.tsx`

**Interfaces:**
- Consumes: `GET /api/report/runs` (Task 2); a panel-supplied `openStream`.
- Produces:
  ```ts
  type RunPhase = "idle" | "running" | "done" | "failed";
  interface Handlers<T> { phase: (p: string) => void; delta: (t: string) => void; done: (payload: T) => void; failed: (msg: string) => void }
  interface OpenStream<T> { (fresh: boolean, params: Record<string, string>, h: Handlers<T>): () => void }
  interface ReportRunView<T> { status: RunPhase; phase: string; deltas: string; report: T | null; error: string | null; params: Record<string, string> | null }
  function useReportRun<T>(apiBase: string, kind: string, openStream: OpenStream<T>): {
    view: ReportRunView<T>;
    start: (paramsKey: string, params: Record<string, string>, fresh?: boolean) => void;
  };
  ```

- [ ] **Step 1: Write the failing test**

```tsx
// packages/console/src/report/__tests__/useReportRun.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useReportRun } from "../useReportRun.js";

// A fake openStream we can drive; records how it was called.
function makeOpen() {
  const calls: { fresh: boolean; params: Record<string, string> }[] = [];
  let hExternal: any = null;
  const open = (fresh: boolean, params: Record<string, string>, h: any) => { calls.push({ fresh, params }); hExternal = h; return () => {}; };
  return { open, calls, fire: (t: string, v?: any) => hExternal[t](v) };
}

beforeEach(() => vi.restoreAllMocks());

describe("useReportRun", () => {
  it("start() with no in-flight run opens a live stream and folds events", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ runs: [] }) }));
    const o = makeOpen();
    const { result } = renderHook(() => useReportRun<{ n: number }>("http://x", "insights", o.open));
    await waitFor(() => expect(fetch).toHaveBeenCalled());   // mount poll (no runs)

    act(() => result.current.start("/p", { root: "/p" }));
    await waitFor(() => expect(o.calls.length).toBe(1));
    expect(o.calls[0]).toEqual({ fresh: false, params: { root: "/p" } });

    act(() => o.fire("phase", "judging"));
    expect(result.current.view.status).toBe("running");
    expect(result.current.view.phase).toBe("judging");
    act(() => o.fire("done", { n: 7 }));
    expect(result.current.view.status).toBe("done");
    expect(result.current.view.report).toEqual({ n: 7 });
  });

  it("start() on an already-running key does NOT open a stream (avoids double-compute)", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ runs: [] }) })   // mount
      .mockResolvedValueOnce({ ok: true, json: async () => ({ runs: [{ id: "insights:/p", kind: "insights", paramsKey: "/p", params: { root: "/p" }, status: "running", phase: "judging", startedAt: 1 }] }) })); // start guard
    const o = makeOpen();
    const { result } = renderHook(() => useReportRun("http://x", "insights", o.open));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    act(() => result.current.start("/p", { root: "/p" }));
    await waitFor(() => expect(result.current.view.status).toBe("running"));
    expect(o.calls.length).toBe(0);   // attached via poll, no stream opened
  });

  it("reattaches a DONE run on mount by opening the stream once (cache hit)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ runs: [{ id: "insights:/p", kind: "insights", paramsKey: "/p", params: { root: "/p" }, status: "done", phase: "done", startedAt: 1, finishedAt: 2 }] }) }));
    const o = makeOpen();
    const { result } = renderHook(() => useReportRun<{ n: number }>("http://x", "insights", o.open));
    await waitFor(() => expect(o.calls.length).toBe(1));
    expect(o.calls[0]).toEqual({ fresh: false, params: { root: "/p" } });
    act(() => o.fire("done", { n: 3 }));
    expect(result.current.view.report).toEqual({ n: 3 });
  });

  it("reattaches a FAILED run on mount from the record (no stream)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ runs: [{ id: "rubric:k", kind: "rubric", paramsKey: "k", params: {}, status: "failed", phase: "x", startedAt: 1, finishedAt: 2, error: "boom" }] }) }));
    const o = makeOpen();
    const { result } = renderHook(() => useReportRun("http://x", "rubric", o.open));
    await waitFor(() => expect(result.current.view.status).toBe("failed"));
    expect(result.current.view.error).toBe("boom");
    expect(o.calls.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/console/src/report/__tests__/useReportRun.test.tsx`
Expected: FAIL — `Cannot find module '../useReportRun.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/console/src/report/useReportRun.ts
// Adds background/reattach/notify awareness to a report panel WITHOUT changing how
// it streams. The panel passes its existing stream opener (openInsightsStream etc.,
// normalized to Handlers<T>); the hook decides WHEN to open it: live on a fresh
// start, once-on-done for a reattach (a cache hit), never for a key already running
// (it polls /api/report/runs instead, so we don't kick off a duplicate compute).
import { useCallback, useEffect, useRef, useState } from "react";

export type RunPhase = "idle" | "running" | "done" | "failed";
export interface Handlers<T> { phase: (p: string) => void; delta: (t: string) => void; done: (payload: T) => void; failed: (msg: string) => void }
export interface OpenStream<T> { (fresh: boolean, params: Record<string, string>, h: Handlers<T>): () => void }
export interface ReportRunView<T> { status: RunPhase; phase: string; deltas: string; report: T | null; error: string | null; params: Record<string, string> | null }

interface RunSummary { id: string; kind: string; paramsKey: string; params: Record<string, string>; status: "running" | "done" | "failed"; phase: string; startedAt: number; error?: string }

const IDLE = { status: "idle" as RunPhase, phase: "", deltas: "", report: null, error: null, params: null };
const POLL_MS = 1500;

export function useReportRun<T>(apiBase: string, kind: string, openStream: OpenStream<T>) {
  const [view, setView] = useState<ReportRunView<T>>(IDLE);
  const closeRef = useRef<(() => void) | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aliveRef = useRef(true);

  const handlers = useCallback((): Handlers<T> => ({
    phase: (p) => setView((s) => ({ ...s, status: "running", phase: p })),
    delta: (t) => setView((s) => ({ ...s, deltas: s.deltas + t })),
    done: (payload) => setView((s) => ({ ...s, status: "done", phase: "done", report: payload })),
    failed: (msg) => setView((s) => ({ ...s, status: "failed", error: msg })),
  }), []);

  const openLive = useCallback((fresh: boolean, params: Record<string, string>) => {
    closeRef.current?.();
    setView({ ...IDLE, status: "running", phase: "starting", params });
    closeRef.current = openStream(fresh, params, handlers());
  }, [openStream, handlers]);

  const fetchRuns = useCallback(async (): Promise<RunSummary[]> => {
    try { const r = await fetch(`${apiBase}/api/report/runs`); return r.ok ? ((await r.json()).runs as RunSummary[]) : []; } catch { return []; }
  }, [apiBase]);

  // Poll /runs for one key until it leaves "running", then open the stream once (cache hit) to load the report.
  const attachAndPoll = useCallback((paramsKey: string, params: Record<string, string>) => {
    setView({ ...IDLE, status: "running", phase: "resuming…", params });
    const tick = async () => {
      const runs = await fetchRuns();
      if (!aliveRef.current) return;
      const rec = runs.find((x) => x.kind === kind && x.paramsKey === paramsKey);
      if (!rec || rec.status === "running") { if (rec?.phase) setView((s) => ({ ...s, phase: rec.phase })); pollRef.current = setTimeout(tick, POLL_MS); return; }
      if (rec.status === "failed") { setView((s) => ({ ...s, status: "failed", error: rec.error ?? "failed" })); return; }
      openLive(false, params);   // done → cache hit loads the report
    };
    pollRef.current = setTimeout(tick, POLL_MS);
  }, [fetchRuns, kind, openLive]);

  const start = useCallback((paramsKey: string, params: Record<string, string>, fresh = false) => {
    if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null; }
    if (fresh) { openLive(true, params); return; }
    // Guard: if this key is already running, attach instead of opening a 2nd stream.
    void fetchRuns().then((runs) => {
      const rec = runs.find((x) => x.kind === kind && x.paramsKey === paramsKey);
      if (rec && rec.status === "running") attachAndPoll(paramsKey, params);
      else openLive(false, params);
    });
  }, [fetchRuns, kind, openLive, attachAndPoll]);

  // Mount: reattach the latest run of this kind.
  useEffect(() => {
    aliveRef.current = true;
    void fetchRuns().then((runs) => {
      if (!aliveRef.current) return;
      const rec = runs.filter((x) => x.kind === kind).sort((a, b) => b.startedAt - a.startedAt)[0];
      if (!rec) return;
      if (rec.status === "running") attachAndPoll(rec.paramsKey, rec.params);
      else if (rec.status === "failed") setView({ ...IDLE, status: "failed", phase: rec.phase, error: rec.error ?? "failed", params: rec.params });
      else openLive(false, rec.params);   // done → cache hit
    });
    return () => { aliveRef.current = false; closeRef.current?.(); if (pollRef.current) clearTimeout(pollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase, kind]);

  return { view, start };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/console/src/report/__tests__/useReportRun.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/report/useReportRun.ts packages/console/src/report/__tests__/useReportRun.test.tsx
git commit -m "feat(console): useReportRun — reattach-latest + duplicate-run guard over existing streams"
```

---

### Task 4: `detectReportDone` + `ActivityProvider` + activity menu + Shell mount

The cross-app surface. Poll `/api/report/runs`, fire the existing notify stack on new completions (with the baseline fix), render a bell-adjacent dropdown that deep-links back.

**Files:**
- Modify: `packages/console/src/notify/events.ts` (add `detectReportDone`)
- Create: `packages/console/src/notify/ActivityProvider.tsx`
- Create: `packages/console/src/notify/ActivityMenu.tsx`
- Modify: `packages/console/src/shell/Shell.tsx` (mount provider; render menu next to `NotifyBell`)
- Modify: `packages/console/src/shell/theme.css`
- Test: `packages/console/src/notify/__tests__/reportEvents.test.ts`

**Interfaces:**
- Consumes: `dispatch`, `osNotify`, `readNotifyPref`, `useToast` (existing); `GET /api/report/runs`.
- Produces:
  ```ts
  interface ReportSnapshot { terminal: Record<string, "done" | "failed">; kindOf: Record<string, string> }
  function detectReportDone(prev: ReportSnapshot | null, next: ReportSnapshot, opts?: { firstBaselineAt?: number; startedAt?: Record<string, number> }): NotifyEvent[];
  interface ActivityRun { id: string; kind: string; paramsKey: string; status: "running" | "done" | "failed"; phase: string; startedAt: number }
  function useActivity(): { runs: ActivityRun[] };
  function ActivityProvider(props: { apiBase: string; children: ReactNode }): ReactElement;
  function ActivityMenu(): ReactElement;
  ```

- [ ] **Step 1: Write the failing test (detector; #6 baseline fix included)**

```ts
// packages/console/src/notify/__tests__/reportEvents.test.ts
import { describe, it, expect } from "vitest";
import { detectReportDone, type ReportSnapshot } from "../events.js";

const snap = (terminal: Record<string, "done" | "failed">, kindOf: Record<string, string> = {}): ReportSnapshot => ({ terminal, kindOf });

describe("detectReportDone", () => {
  it("first snapshot: fires for a run that finished AFTER the provider mounted (baseline fix)", () => {
    // A cached run that completes between mount and first poll should still notify.
    const next = snap({ a: "done" }, { a: "insights" });
    const evs = detectReportDone(null, next, { firstBaselineAt: 100, startedAt: { a: 150 } });   // started after mount
    expect(evs).toHaveLength(1);
  });

  it("first snapshot: does NOT fire for a run that was already terminal before mount", () => {
    const next = snap({ a: "done" }, { a: "insights" });
    const evs = detectReportDone(null, next, { firstBaselineAt: 100, startedAt: { a: 50 } });   // started before mount
    expect(evs).toEqual([]);
  });

  it("fires one event per newly-terminal run on a normal transition", () => {
    const evs = detectReportDone(snap({}, { a: "insights" }), snap({ a: "done" }, { a: "insights" }));
    expect(evs).toHaveLength(1);
    expect(evs[0].title).toMatch(/Insights/);
    expect(evs[0].message).toMatch(/ready/);
  });

  it("does not re-fire for an already-terminal run", () => {
    const evs = detectReportDone(snap({ a: "done" }, { a: "insights" }), snap({ a: "done", b: "failed" }, { a: "insights", b: "rubric" }));
    expect(evs).toHaveLength(1);
    expect(evs[0].message).toMatch(/failed/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/console/src/notify/__tests__/reportEvents.test.ts`
Expected: FAIL — `detectReportDone` not exported.

- [ ] **Step 3: Add `detectReportDone` to `events.ts`**

Append to `packages/console/src/notify/events.ts`:
```ts
export interface ReportSnapshot {
  terminal: Record<string, "done" | "failed">;   // run id -> terminal status
  kindOf: Record<string, string>;                 // run id -> kind
}

const KIND_LABEL: Record<string, string> = { insights: "Insights", rubric: "Rubric", analyze: "Analysis" };

// One NotifyEvent per run that became terminal since `prev`. On the FIRST snapshot
// (prev === null) we normally stay silent, EXCEPT for a run that started after the
// provider mounted (firstBaselineAt) — that's an instant cached run that finished
// before the first poll and would otherwise be swallowed (#6).
export function detectReportDone(
  prev: ReportSnapshot | null,
  next: ReportSnapshot,
  opts?: { firstBaselineAt?: number; startedAt?: Record<string, number> },
): NotifyEvent[] {
  const out: NotifyEvent[] = [];
  for (const [id, status] of Object.entries(next.terminal)) {
    if (prev) {
      if (prev.terminal[id]) continue;
    } else {
      const started = opts?.startedAt?.[id];
      if (!(opts?.firstBaselineAt != null && started != null && started >= opts.firstBaselineAt)) continue;
    }
    const label = KIND_LABEL[next.kindOf[id]] ?? "Report";
    out.push({
      key: `report-${id}-${status}`,
      title: status === "done" ? `${label} ready` : `${label} failed`,
      message: status === "done" ? `Your ${label.toLowerCase()} report finished.` : `Your ${label.toLowerCase()} report failed.`,
    });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/console/src/notify/__tests__/reportEvents.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Create `ActivityProvider.tsx`**

```tsx
// packages/console/src/notify/ActivityProvider.tsx
// Mounted once in Shell. Polls the report run list, exposes it via context for the
// activity menu, and fires the existing notify stack (toast + OS banner) when a run
// becomes terminal — mirroring NotificationsProvider's poll+detect+fire.
import { createContext, useContext, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { useToast } from "../shell/Toast.js";
import { dispatch } from "./dispatch.js";
import { osNotify } from "./osNotify.js";
import { readNotifyPref } from "./prefs.js";
import { detectReportDone, type ReportSnapshot } from "./events.js";

const POLL_MS = 5000;

export interface ActivityRun { id: string; kind: string; paramsKey: string; status: "running" | "done" | "failed"; phase: string; startedAt: number }

const ActivityCtx = createContext<{ runs: ActivityRun[] }>({ runs: [] });
export const useActivity = () => useContext(ActivityCtx);

export function ActivityProvider({ apiBase, children }: { apiBase: string; children: ReactNode }): ReactElement {
  const { push } = useToast();
  const [runs, setRuns] = useState<ActivityRun[]>([]);
  const prev = useRef<ReportSnapshot | null>(null);
  const mountAt = useRef<number>(0);

  useEffect(() => {
    let alive = true;
    mountAt.current = performance.now() ? Date.now() : Date.now();   // wall clock; matches server startedAt
    const poll = async () => {
      try {
        const r = await fetch(`${apiBase}/api/report/runs`);
        if (!alive || !r.ok) return;
        const list = ((await r.json()).runs as ActivityRun[]) ?? [];
        setRuns(list);
        const terminal: Record<string, "done" | "failed"> = {};
        const kindOf: Record<string, string> = {};
        const startedAt: Record<string, number> = {};
        for (const x of list) { kindOf[x.id] = x.kind; startedAt[x.id] = x.startedAt; if (x.status !== "running") terminal[x.id] = x.status; }
        const next: ReportSnapshot = { terminal, kindOf };
        for (const ev of detectReportDone(prev.current, next, { firstBaselineAt: mountAt.current, startedAt })) {
          dispatch(ev, { enabled: readNotifyPref(), hidden: document.visibilityState === "hidden" || !document.hasFocus(), toast: push, notify: osNotify });
        }
        prev.current = next;
      } catch { /* best-effort */ }
    };
    void poll();
    const h = setInterval(poll, POLL_MS);
    return () => { alive = false; clearInterval(h); };
  }, [apiBase, push]);

  return <ActivityCtx.Provider value={{ runs }}>{children}</ActivityCtx.Provider>;
}
```

- [ ] **Step 6: Create `ActivityMenu.tsx`**

```tsx
// packages/console/src/notify/ActivityMenu.tsx
// A button showing the count of in-flight runs; the dropdown lists recent runs and
// deep-links to each one's panel (the panel reattaches the latest run of its kind).
import { useState, type ReactElement } from "react";
import { useActivity, type ActivityRun } from "./ActivityProvider.js";

const ROUTE_FOR: Record<string, string> = { insights: "#/insights", rubric: "#/rubrics", analyze: "#/curate" };
const KIND_LABEL: Record<string, string> = { insights: "Insights", rubric: "Rubric", analyze: "Analysis" };

function label(r: ActivityRun): string {
  const kind = KIND_LABEL[r.kind] ?? r.kind;
  if (r.status === "running") return `${kind} — ${r.phase}`;
  if (r.status === "failed") return `${kind} — failed`;
  return `${kind} — done`;
}

export function ActivityMenu(): ReactElement {
  const { runs } = useActivity();
  const [open, setOpen] = useState(false);
  const active = runs.filter((r) => r.status === "running").length;

  const go = (r: ActivityRun) => { const route = ROUTE_FOR[r.kind]; if (route) window.location.hash = route; setOpen(false); };

  return (
    <div className="activity-menu">
      <button type="button" className={"activity-toggle" + (active > 0 ? " is-active" : "")}
        aria-label={active > 0 ? `${active} running report${active === 1 ? "" : "s"}` : "Report activity"}
        aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        🗂{active > 0 && <span className="activity-count">{active}</span>}
      </button>
      {open && (
        <div className="activity-pop" role="menu">
          {runs.length === 0
            ? <div className="activity-empty">No recent reports.</div>
            : runs.slice(0, 12).map((r) => (
                <button key={r.id} type="button" role="menuitem" className={"activity-row activity-" + r.status} onClick={() => go(r)}>
                  <span className={"activity-dot activity-dot-" + r.status} aria-hidden="true" />{label(r)}
                </button>
              ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 7: Mount in `Shell.tsx`**

Add imports (~lines 8–9):
```tsx
import { ActivityProvider } from "../notify/ActivityProvider.js";
import { ActivityMenu } from "../notify/ActivityMenu.js";
```
Wrap the console tree with `ActivityProvider` just inside `IdentityProvider` (it needs `useToast` from the outer `ToastProvider`): add `<ActivityProvider apiBase={apiBase}>` right after `<IdentityProvider apiBase={apiBase}>` (line 154) and the matching `</ActivityProvider>` right before `</IdentityProvider>` (line 209).
Render the menu next to the bell (line 171):
```tsx
            AgentGem
            <NotifyBell />
            <ActivityMenu />
```

- [ ] **Step 8: Add CSS to `theme.css`** (mirror `.notify-bell`; use existing tokens — `grep -n "\-\-ink\|\-\-surface\|\-\-brand" packages/console/src/shell/theme.css` first and match names; rgba fallbacks where a token is absent):
```css
.activity-menu { position: relative; display: inline-flex; }
.activity-toggle { background: none; border: 0; cursor: pointer; font-size: 15px; padding: 2px 4px; position: relative; opacity: .7; }
.activity-toggle:hover, .activity-toggle.is-active { opacity: 1; }
.activity-count { position: absolute; top: -2px; right: -4px; min-width: 14px; height: 14px; padding: 0 3px; border-radius: 7px; background: var(--brand); color: #fff; font-size: 10px; line-height: 14px; text-align: center; }
.activity-pop { position: absolute; top: 100%; right: 0; z-index: 30; margin-top: 4px; min-width: 240px; background: var(--surface); border: 1px solid rgba(0,0,0,.12); border-radius: 8px; box-shadow: 0 6px 24px rgba(0,0,0,.18); padding: 4px; }
.activity-empty { padding: 10px 12px; color: #666; font-size: 13px; }
.activity-row { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; background: none; border: 0; cursor: pointer; padding: 8px 10px; border-radius: 6px; font-size: 13px; color: var(--ink); }
.activity-row:hover { background: rgba(0,0,0,.05); }
.activity-dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; }
.activity-dot-running { background: var(--brand); }
.activity-dot-done { background: #2e9e5b; }
.activity-dot-failed { background: #d24b4b; }
```

- [ ] **Step 9: Typecheck + tests**

Run: `cd packages/console && npx tsc --noEmit && npx vitest run src/notify`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/console/src/notify/events.ts packages/console/src/notify/ActivityProvider.tsx packages/console/src/notify/ActivityMenu.tsx packages/console/src/notify/__tests__/reportEvents.test.ts packages/console/src/shell/Shell.tsx packages/console/src/shell/theme.css
git commit -m "feat(console): report-done notifications + activity menu"
```

---

### Task 5: Insights panel retrofit (the working proof)

Keep the panel's report state, rendering, and `openInsightsStream` wiring; wrap them with `useReportRun` so the run survives navigation and reattaches on return.

**Files:**
- Modify: `packages/console/src/panels/Insights/index.tsx`
- Test: `packages/console/src/panels/Insights/index.test.tsx` (new — the Issue-2 smoke test)

**Interfaces:**
- Consumes: `useReportRun` (Task 3). The insights `done` payload is `T = { report: InsightsReportView; degraded: boolean; scanned?: number; updatedAt: number | null }` (exactly what `openInsightsStream`'s `done` already delivers).

- [ ] **Step 1: Replace the stream driver with the hook**

Add `import { useReportRun, type Handlers } from "../../report/useReportRun.js";`. Define the payload type near the top:
```tsx
type InsightsDone = { report: InsightsReportView; degraded: boolean; scanned?: number; updatedAt: number | null };
```
Replace the streaming state block (`index.tsx:33-42`) and the effects + `generate` (`:44-60`) with:
```tsx
  const [projects, setProjects] = useState<ProjectCandidate[] | null>(null);
  const [recents, setRecents] = useState<RecentEntry[] | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  // openStream adapter: the hook decides WHEN to open; this maps openInsightsStream's
  // events to the normalized Handlers and closes over the current root.
  const openStream = useCallback(
    (fresh: boolean, params: Record<string, string>, h: Handlers<InsightsDone>) =>
      openInsightsStream(apiBase, params.root, (e) => {
        if (e.type === "phase") h.phase(e.sessions != null ? `${e.phase} (${e.sessions} sessions)` : e.phase);
        else if (e.type === "delta") h.delta(e.text);
        else if (e.type === "done") h.done({ report: e.report, degraded: e.degraded, scanned: e.scanned, updatedAt: e.updatedAt });
        else if (e.type === "failed") h.failed(e.message);
      }, fresh),
    [apiBase],
  );
  const { view, start } = useReportRun<InsightsDone>(apiBase, "insights", openStream);

  useEffect(() => {
    const client = makeClient(apiBase);
    testbedProjectsRoute.call(client).then((r) => setProjects(r.projects)).catch(() => setProjects([]));
    testbedRecentsRoute.call(client).then((r) => setRecents(r.recents)).catch(() => setRecents([]));
  }, [apiBase]);

  // Reattached a run on mount → select its row.
  useEffect(() => { const root = view.params?.root; if (root && !activePath) setActivePath(root); }, [view.params, activePath]);

  const generate = (path: string, fresh = false) => { setActivePath(path); start(path, { root: path }, fresh); };
```
Add `useCallback` to the React import. `paramsKey` for insights is the path itself (`start(path, { root: path }, fresh)`).

- [ ] **Step 2: Map render fields from `view`**

Just above the `return`, derive the names the existing JSX (`:100-141`) already uses:
```tsx
  const running = view.status === "running";
  const report = view.report?.report ?? null;
  const updatedAt = view.report?.updatedAt ?? null;
  const scanned = view.report?.scanned ?? null;
  const degraded = view.report?.degraded ?? false;
  const phase = view.phase;
  const error = view.error;
  const out = view.deltas;
```
The existing JSX compiles unchanged (it already references these names). `InsightsReportCard` still receives an `InsightsReportView`, which is `view.report?.report`.

- [ ] **Step 3: Write the Issue-2 smoke test**

```tsx
// packages/console/src/panels/Insights/index.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Insights } from "./index.js";

// Fake EventSource so openInsightsStream can drive the panel.
class FakeES {
  static last: FakeES | null = null;
  listeners = new Map<string, (e: MessageEvent) => void>();
  constructor(public url: string) { FakeES.last = this; }
  addEventListener(t: string, cb: (e: MessageEvent) => void) { this.listeners.set(t, cb); }
  close() {}
  fire(t: string, data: unknown) { this.listeners.get(t)?.({ data: JSON.stringify(data) } as MessageEvent); }
}

beforeEach(() => {
  (globalThis as any).EventSource = FakeES as unknown;
  FakeES.last = null;
  // /api/report/runs (mount reattach: none) + the two testbed routes.
  vi.stubGlobal("fetch", vi.fn(async (u: string) => {
    if (String(u).includes("/api/report/runs")) return { ok: true, json: async () => ({ runs: [] }) } as any;
    return { ok: true, json: async () => ({ projects: [{ path: "/proj", flavor: "claude", name: "proj" }], recents: [] }) } as any;
  }));
});

describe("Insights panel (retrofit smoke test)", () => {
  it("renders the report when a run reports done", async () => {
    render(<Insights apiBase="http://x" />);
    const btn = await screen.findAllByText("Insights →");
    fireEvent.click(btn[0]);
    await waitFor(() => expect(FakeES.last).not.toBeNull());
    FakeES.last!.fire("done", {
      report: { totals: { sessions: 2, mostly: 1, partially: 1, not: 0 }, outcomes_summary: "went well", narrative: "N", by_model: [], friction: [], publish_candidates: [] },
      signalSummary: { sessionsScanned: 2 }, degraded: false, updatedAt: 123,
    });
    await waitFor(() => expect(screen.getByText("went well")).toBeTruthy());   // InsightsReportCard rendered
  });
});
```

- [ ] **Step 4: Typecheck + test**

Run: `cd packages/console && npx tsc --noEmit && npx vitest run src/panels/Insights src/report`
Expected: PASS.

- [ ] **Step 5: Manual browser verification (required — jsdom can't prove notifications/appearance)**

Run the console against a project with session history:
1. Click **Insights →** → live phase + `run-transcript` deltas stream as today.
2. Navigate to Sessions mid-run → the `🗂` menu shows `1` and lists "Insights — <phase>".
3. On completion, a toast fires (OS banner if the window is backgrounded).
4. Return to **Insights** → the row is selected and shows the finished report (reattach → cache-hit stream open).
5. Start Insights on project A, then B; leave and return → panel shows B (reattach-latest, as designed).
6. **Re-run ↻** while a run is in flight → forces a fresh compute (does not silently no-op).

- [ ] **Step 6: Commit**

```bash
git add packages/console/src/panels/Insights/index.tsx packages/console/src/panels/Insights/index.test.tsx
git commit -m "feat(console): Insights survives navigation via useReportRun"
```

---

### Task 6: PR1 — core + Insights

- [ ] **Step 1: Full suites**

Run: `cd /Users/rfeng/Projects/ninemind/agentgem-worktrees/async-report-runs && npm run build && npx vitest run src && (cd packages/console && npx tsc --noEmit && npx vitest run)`
Expected: PASS.

- [ ] **Step 2: Push + PR (off freshly-fetched origin/main)**

```bash
git push -u origin feat/async-report-runs
gh pr create --title "Background report runs: registry + Insights (PR1)" --body "$(cat <<'BODY'
Lightweight background-report-runs, part 1. The existing report SSE routes already
continue + cache after a client disconnects; this adds an in-memory ReportRegistry
they update, GET /api/report/runs, a notify-on-done ActivityProvider + activity menu,
and a useReportRun hook that reattaches the latest run of a kind on mount and refuses
to open a duplicate stream. Wires Insights end-to-end. No queue, no concurrency change.

Rubric + Analyze follow in PR2. Scorecard/gem-run out of scope (see spec).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

- [ ] **Step 3: Watch CI, merge when green, verify each commit on origin/main**

```bash
gh run watch <run-id> --exit-status && gh pr merge --rebase --delete-branch
git fetch origin && git grep -l "class ReportRegistry" origin/main -- src/report/registry.ts && git grep -l "useReportRun" origin/main -- packages/console/src/report/useReportRun.ts
```

---

### Task 7: Rubric panel retrofit (PR2)

**Files:**
- Read first: `packages/console/src/panels/Rubrics/index.tsx` + `rubricStream.ts` (current `openRubricStream(apiBase, params, onEvent, fresh)` usage).
- Modify: `packages/console/src/panels/Rubrics/index.tsx`

**Interfaces:**
- Consumes: `useReportRun` (Task 3). Rubric `done` payload `T = { report: RubricReportView; cached: boolean; updatedAt: number | null }`. `paramsKey` = `` `${rubric}:${scope}:${root ?? ""}:${sessionId ?? ""}` `` — **must match `rubricParamsKey` on the server** (Task 2). `params` passed to the hook = `{ rubric, scope, root, sessionId }` (only the keys present).

- [ ] **Step 1: Swap the driver for the hook**

Add `import { useReportRun, type Handlers } from "../../report/useReportRun.js";` and:
```tsx
type RubricDone = { report: RubricReportView; cached: boolean; updatedAt: number | null };
```
Provide the openStream adapter mapping `openRubricStream`'s events (`start`/`delta`/`done`/`failed`) to `Handlers` (map the `start` event to `h.phase("evaluating")`, `delta`→`h.delta`, `done`→`h.done({ report, cached, updatedAt })`, `failed`→`h.failed(message)`), reconstructing the `RubricScopeParams` from `params`. Replace the panel's run handler with:
```tsx
  const { view, start } = useReportRun<RubricDone>(apiBase, "rubric", openStream);
  const run = (p: { rubric: string; scope: "all" | "project" | "session"; root?: string; sessionId?: string }, fresh = false) => {
    const key = `${p.rubric}:${p.scope}:${p.root ?? ""}:${p.sessionId ?? ""}`;
    const params: Record<string, string> = { rubric: p.rubric, scope: p.scope };
    if (p.root) params.root = p.root; if (p.sessionId) params.sessionId = p.sessionId;
    start(key, params, fresh);
  };
```
Map render fields as in Task 5 Step 2 (`running = view.status === "running"`, `report = view.report?.report ?? null`, `updatedAt = view.report?.updatedAt ?? null`, `phase = view.phase`, `error = view.error`, deltas = `view.deltas`). Keep the report card + scope selectors unchanged.

- [ ] **Step 2: Typecheck + manual browser verify** (`cd packages/console && npx tsc --noEmit`; run a rubric, navigate away mid-run, confirm activity menu + notify + reattach).

- [ ] **Step 3: Commit** — `git commit -m "feat(console): Rubric evaluation survives navigation"`

---

### Task 8: Curate Analyze panel retrofit (PR2)

**Files:**
- Read first: `packages/console/src/panels/Curate/Analyze.tsx` + `analyzeStream.ts` (`openAnalyzeStream(apiBase, root, fresh, onEvent)`; `done` carries `candidates`, not a `report`).
- Modify: `packages/console/src/panels/Curate/Analyze.tsx`

**Interfaces:**
- Consumes: `useReportRun` (Task 3). Analyze `done` payload `T = { candidates: AnalyzeCandidate[]; cached: boolean }`. `paramsKey` = the project root.

- [ ] **Step 1: Swap the driver for the hook**

Add `import { useReportRun, type Handlers } from "../../report/useReportRun.js";` and `import type { AnalyzeCandidate } from "./analyzeStream.js";`. Define `type AnalyzeDone = { candidates: AnalyzeCandidate[]; cached: boolean };`. openStream adapter maps `openAnalyzeStream(apiBase, params.root, fresh, onEvent)` events (`phase`→`h.phase`, `delta`→`h.delta`, `done`→`h.done({ candidates: e.candidates, cached: e.cached })`, `failed`→`h.failed(e.message)`). Then:
```tsx
  const { view, start } = useReportRun<AnalyzeDone>(apiBase, "analyze", openStream);
  const analyze = (root: string, fresh = false) => start(root, { root }, fresh);
```
Render fields: `running = view.status === "running"`, `candidates = view.report?.candidates ?? []`, `phase = view.phase`, `error = view.error`, deltas = `view.deltas`. Preserve the `consumePendingAnalyze()` hand-off (Insights → Curate): if a pending root is consumed on mount, call `analyze(root)` (this races with the hook's own mount reattach — the reattach is a no-op if no analyze run exists, and if one does, `start`'s guard attaches rather than double-opening).

- [ ] **Step 2: Typecheck + manual browser verify** (from Insights, "Build a Gem from this project →" hands off to Analyze; confirm run survives navigation + notifies + reattaches).

- [ ] **Step 3: Commit** — `git commit -m "feat(console): Curate analysis survives navigation"`

---

### Task 9: PR2 — Rubric + Analyze

- [ ] **Step 1:** `cd packages/console && npx tsc --noEmit && npx vitest run` → PASS.
- [ ] **Step 2:** Push a fresh branch off freshly-fetched `origin/main` (do NOT append to the merged PR1 branch), open PR2, watch CI, merge, verify both commits' markers on `origin/main`.

---

## Deferred (documented, not in scope)

- **Scorecard (Mine):** not agent-backed (`collectScorecard` is a pure sync scan) and already stale-while-revalidate — no user-visible gap. Its route emits `stale`/`progress`, not a single `done` report, so it doesn't fit the `track.done()` shape without extra work.
- **Gem-run (Optimize):** an execution, not a report; `streamGemRun` has no `done` report payload to reattach to.
- **Precise per-run reattach:** reattach is by latest-of-kind. Restoring the exact run a user was viewing (localStorage pointer + selected-row persistence) is deferred — revisit only if the multi-run edge (two Insights projects, return lands on the newer) actually bites.
- **Cancel a running report:** not needed in this design (no queue; a wedged run only affects its own key, and the existing routes already behave this way today).
- **Phase in the activity menu for rubric:** rubric's route has no phase callback, so its menu label shows a single "evaluating" phase until done. Fine for v1.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_open→resolved | 2 review issues + 1 scope split + outside-voice pivot; all folded |
| Outside Voice | Claude subagent | Independent 2nd opinion | 1 | issues_found | 7 findings; #1/#2/#7 drove the architecture pivot, #3 bug fixed, #6 folded |

- **CROSS-MODEL:** The review accepted the `ReportRunManager` + serial-queue + new-SSE-view framing; the outside voice showed it was a concurrency regression serving the weakest goal. Both converged (with user approval) on the lightweight registry-over-existing-routes design now in this plan.
- **VERDICT:** ENG CLEARED — plan rewritten to the reviewed design; ready to implement. Ships in two PRs (core+Insights, then Rubric+Analyze).

**Decisions folded into the plan:**
- Scope split into two PRs (blast radius / dropped-commit-trap).
- Reattach = latest-of-kind (Issue 1); precise pointer deferred.
- Insights retrofit smoke test added (Issue 2).
- Pivot to lightweight registry over existing routes (cross-model tension).
- `#3` Re-run/force bug dissolved by design; `#5` moot (routes kept); `#6` baseline-notification fix included.

**UNRESOLVED DECISIONS:**
- T2 (P2): whether to cap `attachAndPoll` at ~10min now or defer — left to the user; not blocking.
