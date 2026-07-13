# Background Report Runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agent-backed report generation (Insights, Rubric, Analyze) run as background jobs that survive navigation, notify on completion, and are visible/re-attachable from a cross-app activity view.

**Architecture:** A process-wide `ReportRunManager` (server, `src/report/`) owns runs in a sequential queue — mirroring the existing `ChatManager`. Report SSE becomes a *view onto a run* rather than *being* the run, so a client disconnect can't abort the work. The React console gets a `useReportRun` hook (re-attaches the latest run of a kind on mount) and an `ActivityProvider`/activity menu that polls the run list, fires the existing notification stack on completion, and deep-links back to each run's panel.

**Tech Stack:** TypeScript, Node, Express (raw routes on `server.expressApp`), React 18, native `EventSource`/`fetch`, Vitest.

## Global Constraints

- **Scope:** Only the three agent-backed report kinds with a clean compute-core seam — **insights, rubric, analyze**. Scorecard (not agent-backed; already stale-while-revalidate) and gem-run (an execution with no `{payload,cached,updatedAt}` core) are **out of scope** for this plan; each is noted as deferred where relevant.
- **Concurrency:** exactly one run executes at a time (sequential queue), bracketed in `beginForeground()/endForeground()` so the `warm` daemon yields. No global agent mutex.
- **Persistence:** in-memory registry only. Survives navigation + page reload (registry lives in the server process). A full server restart drops in-flight runs — acceptable, re-running is cache-backed. **No disk, no localStorage pointer.**
- **Re-attach fidelity:** status + phase, then the report. Live `delta` streaming is preserved *while a client is attached*; no server-side historical delta buffer.
- **ID generation:** `randomUUID` from `node:crypto` (the repo's non-ChatManager idiom).
- **SSE writer idiom (verbatim):** `res.write(\`event: ${event}\ndata: ${JSON.stringify(data)}\n\n\`)`.
- **SSE headers (verbatim):** `{ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" }`.
- **Logger:** `import { createLogger } from "@agentgem/base"`.
- **Route registration idiom:** `server.expressApp.<method>(path, originGuard, handler)` inside `finalizeCommonApp(app, server)` in `src/appCommon.ts`.
- **Console tests are NOT in CI** — run them locally. Root `src/__tests__` and `src/report/__tests__` tests ARE CI-gated (`test (24)`).
- **Marketplace/console has no CSS framework:** every new `class` you add to a `.tsx` needs a matching hand-authored rule (see Task 8's CSS step). Verify styled UI in a real browser, not just jsdom.

---

### Task 1: `ReportRunManager` core (server)

The registry, sequential queue, dedup, background-completion, and TTL/cap eviction. Runners are injected in Task 2; this task tests with fake runners.

**Files:**
- Create: `src/report/runManager.ts`
- Test: `src/report/__tests__/runManager.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type RunStatus = "queued" | "running" | "done" | "failed";
  interface RunEvent { type: "phase" | "delta" | "done" | "failed"; phase?: string; text?: string; result?: unknown; error?: string }
  interface RunRecord { id: string; kind: string; paramsKey: string; params: unknown; status: RunStatus; phase: string; result?: unknown; error?: string; startedAt: number; finishedAt?: number }
  interface RunSummary { id: string; kind: string; paramsKey: string; status: RunStatus; phase: string; startedAt: number; finishedAt?: number }
  type ReportRunner = (params: unknown, progress: { onPhase: (p: string) => void; onDelta: (t: string) => void }) => Promise<unknown>;
  class ReportRunManager {
    constructor(opts?: { now?: () => number; ttlMs?: number; maxDone?: number });
    register(kind: string, runner: ReportRunner): void;
    start(kind: string, paramsKey: string, params: unknown): { id: string; existing: boolean };
    get(id: string): RunRecord | undefined;
    list(): RunSummary[];
    subscribe(id: string, onEvent: (e: RunEvent) => void): () => void;
    sweep(): void;
  }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// src/report/__tests__/runManager.test.ts
import { describe, it, expect } from "vitest";
import { ReportRunManager } from "../runManager.js";

// A runner whose completion we control, so we can assert queue + background behavior.
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("ReportRunManager", () => {
  it("dedups a queued/running run by (kind, paramsKey)", () => {
    const mgr = new ReportRunManager();
    const d = deferred<unknown>();
    mgr.register("insights", () => d.promise);
    const a = mgr.start("insights", "/proj", { root: "/proj" });
    const b = mgr.start("insights", "/proj", { root: "/proj" });
    expect(b.existing).toBe(true);
    expect(b.id).toBe(a.id);
  });

  it("runs sequentially: the second queued run does not start until the first finishes", async () => {
    const mgr = new ReportRunManager();
    const d1 = deferred<unknown>(), d2 = deferred<unknown>();
    const started: string[] = [];
    mgr.register("insights", (p) => { started.push((p as { k: string }).k); return (p as { k: string }).k === "a" ? d1.promise : d2.promise; });
    mgr.start("insights", "a", { k: "a" });
    mgr.start("insights", "b", { k: "b" });
    await Promise.resolve();
    expect(started).toEqual(["a"]);           // only "a" started
    d1.resolve({ ok: true });
    await d1.promise; await Promise.resolve(); await Promise.resolve();
    expect(started).toEqual(["a", "b"]);      // "b" started after "a" finished
  });

  it("completes in the background after all subscribers unsubscribe", async () => {
    const mgr = new ReportRunManager();
    const d = deferred<unknown>();
    mgr.register("insights", () => d.promise);
    const { id } = mgr.start("insights", "/p", { root: "/p" });
    const unsub = mgr.subscribe(id, () => {});
    unsub();                                   // client "navigated away"
    d.resolve({ report: 1 });
    await d.promise; await Promise.resolve();
    expect(mgr.get(id)?.status).toBe("done");
    expect(mgr.get(id)?.result).toEqual({ report: 1 });
  });

  it("a late subscriber on a finished run receives done immediately", async () => {
    const mgr = new ReportRunManager();
    mgr.register("insights", () => Promise.resolve({ report: 2 }));
    const { id } = mgr.start("insights", "/p", { root: "/p" });
    await Promise.resolve(); await Promise.resolve();
    const events: unknown[] = [];
    mgr.subscribe(id, (e) => events.push(e));
    expect(events).toEqual([{ type: "done", result: { report: 2 } }]);
  });

  it("marks a run failed and reports the message", async () => {
    const mgr = new ReportRunManager();
    mgr.register("insights", () => Promise.reject(new Error("boom")));
    const { id } = mgr.start("insights", "/p", { root: "/p" });
    await Promise.resolve(); await Promise.resolve();
    expect(mgr.get(id)?.status).toBe("failed");
    expect(mgr.get(id)?.error).toBe("boom");
  });

  it("frees the dedup slot after completion so a re-run makes a new id", async () => {
    const mgr = new ReportRunManager();
    mgr.register("insights", () => Promise.resolve({}));
    const a = mgr.start("insights", "/p", { root: "/p" });
    await Promise.resolve(); await Promise.resolve();
    const b = mgr.start("insights", "/p", { root: "/p" });
    expect(b.existing).toBe(false);
    expect(b.id).not.toBe(a.id);
  });

  it("sweep evicts finished runs past the TTL", async () => {
    let t = 1000;
    const mgr = new ReportRunManager({ now: () => t, ttlMs: 100 });
    mgr.register("insights", () => Promise.resolve({}));
    const { id } = mgr.start("insights", "/p", { root: "/p" });
    await Promise.resolve(); await Promise.resolve();
    t = 2000;                                  // well past ttl
    mgr.sweep();
    expect(mgr.get(id)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/rfeng/Projects/ninemind/agentgem-worktrees/async-report-runs && npx vitest run src/report/__tests__/runManager.test.ts`
Expected: FAIL — `Cannot find module '../runManager.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/report/runManager.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Process-wide registry for background report runs. Generalizes the ChatManager
// pattern (packages/run/src/chatSession.ts) to agent-backed report generation:
// one sequential queue (honoring the warm foreground gate), dedup by (kind,
// paramsKey), background-completion (the run promise is owned here, never by a
// request), and TTL/cap eviction of finished runs. In-memory only — a run
// survives client navigation + page reload (this lives in the server process)
// but not a full server restart.
import { randomUUID } from "node:crypto";
import { createLogger } from "@agentgem/base";
import { beginForeground, endForeground } from "../warm/orchestrator.js";

const log = createLogger("report-run");

export type RunStatus = "queued" | "running" | "done" | "failed";

export interface RunEvent {
  type: "phase" | "delta" | "done" | "failed";
  phase?: string;
  text?: string;
  result?: unknown;
  error?: string;
}

export interface RunRecord {
  id: string;
  kind: string;
  paramsKey: string;
  params: unknown;
  status: RunStatus;
  phase: string;
  result?: unknown;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface RunSummary {
  id: string; kind: string; paramsKey: string; status: RunStatus; phase: string; startedAt: number; finishedAt?: number;
}

export type ReportRunner = (
  params: unknown,
  progress: { onPhase: (p: string) => void; onDelta: (t: string) => void },
) => Promise<unknown>;

interface LiveRun { record: RunRecord; listeners: Set<(e: RunEvent) => void> }

export class ReportRunManager {
  private runs = new Map<string, LiveRun>();
  private byKey = new Map<string, string>();   // `${kind}:${paramsKey}` -> id, only while queued/running
  private queue: string[] = [];
  private activeId: string | null = null;
  private runners = new Map<string, ReportRunner>();
  private now: () => number;
  private ttlMs: number;
  private maxDone: number;

  constructor(opts: { now?: () => number; ttlMs?: number; maxDone?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? 30 * 60_000;
    this.maxDone = opts.maxDone ?? 50;
  }

  register(kind: string, runner: ReportRunner): void { this.runners.set(kind, runner); }

  start(kind: string, paramsKey: string, params: unknown): { id: string; existing: boolean } {
    const fullKey = `${kind}:${paramsKey}`;
    const existingId = this.byKey.get(fullKey);
    if (existingId) return { id: existingId, existing: true };
    if (!this.runners.has(kind)) throw new Error(`unknown report kind: ${kind}`);
    const id = randomUUID();
    const record: RunRecord = { id, kind, paramsKey, params, status: "queued", phase: "queued", startedAt: this.now() };
    this.runs.set(id, { record, listeners: new Set() });
    this.byKey.set(fullKey, id);
    this.queue.push(id);
    this.pump();
    return { id, existing: false };
  }

  get(id: string): RunRecord | undefined { return this.runs.get(id)?.record; }

  list(): RunSummary[] {
    return [...this.runs.values()]
      .map(({ record: r }) => ({ id: r.id, kind: r.kind, paramsKey: r.paramsKey, status: r.status, phase: r.phase, startedAt: r.startedAt, finishedAt: r.finishedAt }))
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  subscribe(id: string, onEvent: (e: RunEvent) => void): () => void {
    const live = this.runs.get(id);
    if (!live) { onEvent({ type: "failed", error: "run not found" }); return () => {}; }
    const r = live.record;
    if (r.status === "done") { onEvent({ type: "done", result: r.result }); return () => {}; }
    if (r.status === "failed") { onEvent({ type: "failed", error: r.error }); return () => {}; }
    onEvent({ type: "phase", phase: r.phase });   // catch a late subscriber up to the current phase
    live.listeners.add(onEvent);
    return () => live.listeners.delete(onEvent);
  }

  sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const { record: r } of [...this.runs.values()]) {
      if ((r.status === "done" || r.status === "failed") && r.finishedAt != null && r.finishedAt < cutoff) this.runs.delete(r.id);
    }
    const finished = [...this.runs.values()]
      .filter(({ record: r }) => r.status === "done" || r.status === "failed")
      .sort((a, b) => (a.record.finishedAt ?? 0) - (b.record.finishedAt ?? 0));
    while (finished.length > this.maxDone) this.runs.delete(finished.shift()!.record.id);
  }

  private emit(live: LiveRun, e: RunEvent): void {
    for (const l of live.listeners) { try { l(e); } catch { /* dead subscriber */ } }
  }

  private pump(): void {
    if (this.activeId) return;
    const id = this.queue.shift();
    if (!id) return;
    const live = this.runs.get(id);
    if (!live) { this.pump(); return; }
    this.activeId = id;
    void this.run(live).finally(() => { this.activeId = null; this.sweep(); this.pump(); });
  }

  private async run(live: LiveRun): Promise<void> {
    const r = live.record;
    const runner = this.runners.get(r.kind);
    if (!runner) { r.status = "failed"; r.error = `unknown report kind: ${r.kind}`; r.finishedAt = this.now(); return; }
    r.status = "running"; r.phase = "starting";
    beginForeground();
    try {
      const result = await runner(r.params, {
        onPhase: (p) => { r.phase = p; this.emit(live, { type: "phase", phase: p }); },
        onDelta: (t) => { this.emit(live, { type: "delta", text: t }); },
      });
      r.status = "done"; r.phase = "done"; r.result = result; r.finishedAt = this.now();
      this.emit(live, { type: "done", result });
    } catch (err) {
      r.status = "failed"; r.error = (err as Error)?.message ?? String(err); r.finishedAt = this.now();
      this.emit(live, { type: "failed", error: r.error });
      log.warn("run %s (%s) failed: %s", r.id, r.kind, r.error);
    } finally {
      endForeground();
      this.byKey.delete(`${r.kind}:${r.paramsKey}`);   // free the dedup slot; a re-run makes a new run
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/report/__tests__/runManager.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/report/runManager.ts src/report/__tests__/runManager.test.ts
git commit -m "feat(report): ReportRunManager — sequential background run registry"
```

---

### Task 2: Runner registry (insights, rubric, analyze)

Thin adapters over the existing compute cores. Each returns a kind-specific, panel-shaped result (opaque to the manager).

**Files:**
- Create: `src/report/kinds.ts`
- Test: `src/report/__tests__/kinds.test.ts`

**Interfaces:**
- Consumes: `ReportRunManager.register` (Task 1); `computeInsights` (`src/insightsCore.ts`), `computeRubric`/`resolveRubric` (`src/rubricCore.ts`), `computeWorkflowAnalysis` (`src/workflowCore.ts`).
- Produces:
  ```ts
  function registerReportKinds(mgr: ReportRunManager): void;   // registers "insights" | "rubric" | "analyze"
  // Result shapes (what each run's `result` / the client hook's report will be):
  interface InsightsRunResult { report: InsightsPayload["report"]; degraded: boolean; scanned: number | null; updatedAt: number | null }
  interface RubricRunResult  { report: RubricReport; updatedAt: number | null }
  interface AnalyzeRunResult { report: WorkflowAnalysisPayload; updatedAt: number | null }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// src/report/__tests__/kinds.test.ts
import { describe, it, expect } from "vitest";
import { ReportRunManager } from "../runManager.js";
import { registerReportKinds } from "../kinds.js";

describe("registerReportKinds", () => {
  it("registers insights, rubric, and analyze", () => {
    const mgr = new ReportRunManager();
    // Registration must not throw and each kind must be startable (dedup slot proves register() ran).
    registerReportKinds(mgr);
    expect(() => mgr.start("insights", "/p", { root: "/p" })).not.toThrow();
    expect(() => mgr.start("rubric", "r:all::", { rubric: "r", scope: { kind: "all" } })).not.toThrow();
    expect(() => mgr.start("analyze", "/p", { root: "/p" })).not.toThrow();
  });

  it("rejects an unknown kind", () => {
    const mgr = new ReportRunManager();
    registerReportKinds(mgr);
    expect(() => mgr.start("bogus", "x", {})).toThrow(/unknown report kind/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/report/__tests__/kinds.test.ts`
Expected: FAIL — `Cannot find module '../kinds.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/report/kinds.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Runner adapters over the existing cache-aware compute cores. Each runner is a
// thin bridge: forward the manager's onPhase/onDelta into the core's progress
// callbacks and return the panel-shaped result. The compute cores are unchanged.
import type { ReportRunManager } from "./runManager.js";
import { computeInsights } from "../insightsCore.js";
import { computeRubric, resolveRubric } from "../rubricCore.js";
import { computeWorkflowAnalysis } from "../workflowCore.js";
import type { RubricScope } from "@agentgem/insight";

interface InsightsParams { root: string; dir?: string; fresh?: boolean }
interface RubricParams { rubric: string; scope: RubricScope; dir?: string; fresh?: boolean }
interface AnalyzeParams { root: string; dir?: string; fresh?: boolean }

export function registerReportKinds(mgr: ReportRunManager): void {
  mgr.register("insights", async (params, prog) => {
    const { root, dir, fresh } = params as InsightsParams;
    const { payload, updatedAt } = await computeInsights(root, {
      dir, force: fresh,
      progress: {
        onPhase: (p, extra) => prog.onPhase(extra?.sessions != null ? `${p} (${extra.sessions} sessions)` : p),
        onDelta: prog.onDelta,
      },
    });
    return { report: payload.report, degraded: payload.degraded, scanned: payload.signalSummary?.sessionsScanned ?? null, updatedAt };
  });

  mgr.register("rubric", async (params, prog) => {
    const { rubric, scope, dir, fresh } = params as RubricParams;
    const resolved = resolveRubric(rubric, dir);
    if (!resolved) throw new Error(`unknown rubric: ${rubric}`);
    prog.onPhase("evaluating");
    const { payload, updatedAt } = await computeRubric(resolved, scope, { dir, force: fresh, onDelta: prog.onDelta });
    return { report: payload, updatedAt };
  });

  mgr.register("analyze", async (params, prog) => {
    const { root, dir, fresh } = params as AnalyzeParams;
    const { payload, updatedAt } = await computeWorkflowAnalysis(root, {
      dir, force: fresh,
      progress: { onPhase: (p) => prog.onPhase(p), onDelta: prog.onDelta },
    });
    return { report: payload, updatedAt };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/report/__tests__/kinds.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/report/kinds.ts src/report/__tests__/kinds.test.ts
git commit -m "feat(report): runner adapters for insights/rubric/analyze"
```

---

### Task 3: Report run routes + wiring in `appCommon`

Register the four routes and instantiate the manager alongside `ChatManager`.

**Files:**
- Modify: `src/appCommon.ts` (add imports near line 53–56; instantiate + register routes near the existing SSE block ~line 236–264)
- Test: `src/report/__tests__/routes.test.ts`

**Interfaces:**
- Consumes: `ReportRunManager` (Task 1), `registerReportKinds` (Task 2), `originGuard`, `beginForeground/endForeground` already imported.
- Produces: routes `POST /api/report/run`, `GET /api/report/runs`, `GET /api/report/run/:id`, `GET /api/report/run/:id/stream`. To keep them testable without booting the whole app, extract the handler-wiring into a small pure function `registerReportRoutes(app, manager)`:
  ```ts
  interface ExpressLike { post(path: string, ...h: unknown[]): void; get(path: string, ...h: unknown[]): void }
  function registerReportRoutes(app: ExpressLike, manager: ReportRunManager, guard: unknown): void;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// src/report/__tests__/routes.test.ts
import { describe, it, expect, vi } from "vitest";
import { ReportRunManager } from "../runManager.js";
import { registerReportRoutes } from "../routes.js";

// Minimal Express double: capture handlers by "METHOD path", ignore the guard arg.
function fakeApp() {
  const handlers = new Map<string, (req: any, res: any) => void>();
  const reg = (m: string) => (path: string, ..._rest: any[]) => { handlers.set(`${m} ${path}`, _rest[_rest.length - 1]); };
  return { app: { post: reg("POST"), get: reg("GET") }, handlers };
}
function fakeRes() {
  return { statusCode: 200, body: undefined as unknown, headers: {} as Record<string, string>, writes: [] as string[], ended: false,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
    writeHead(c: number, h: Record<string, string>) { this.statusCode = c; this.headers = h; },
    write(s: string) { this.writes.push(s); return true; },
    end() { this.ended = true; },
    on() { /* no-op */ } };
}

describe("registerReportRoutes", () => {
  it("POST /api/report/run starts a run and returns its id", () => {
    const mgr = new ReportRunManager();
    mgr.register("insights", () => new Promise(() => {}));   // never resolves; stays running
    const { app, handlers } = fakeApp();
    registerReportRoutes(app as any, mgr, {});
    const res = fakeRes();
    handlers.get("POST /api/report/run")!({ body: { kind: "insights", paramsKey: "/p", params: { root: "/p" } } }, res);
    expect((res.body as { id: string }).id).toBeTruthy();
    expect(mgr.list()).toHaveLength(1);
  });

  it("POST /api/report/run 400s without kind/paramsKey", () => {
    const { app, handlers } = fakeApp();
    registerReportRoutes(app as any, new ReportRunManager(), {});
    const res = fakeRes();
    handlers.get("POST /api/report/run")!({ body: {} }, res);
    expect(res.statusCode).toBe(400);
  });

  it("GET /api/report/run/:id 404s for an unknown id", () => {
    const { app, handlers } = fakeApp();
    registerReportRoutes(app as any, new ReportRunManager(), {});
    const res = fakeRes();
    handlers.get("GET /api/report/run/:id")!({ params: { id: "nope" } }, res);
    expect(res.statusCode).toBe(404);
  });

  it("GET /api/report/run/:id/stream writes a phase frame for a running run", () => {
    const mgr = new ReportRunManager();
    mgr.register("insights", () => new Promise(() => {}));
    const { app, handlers } = fakeApp();
    registerReportRoutes(app as any, mgr, {});
    const { id } = mgr.start("insights", "/p", { root: "/p" });
    const res = fakeRes();
    handlers.get("GET /api/report/run/:id/stream")!({ params: { id }, on: () => {} }, res);
    expect(res.headers["Content-Type"]).toBe("text/event-stream");
    expect(res.writes.join("")).toContain("event: phase");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/report/__tests__/routes.test.ts`
Expected: FAIL — `Cannot find module '../routes.js'`.

- [ ] **Step 3: Write minimal implementation (extracted route module)**

```ts
// src/report/routes.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Raw-Express wiring for the report run registry. Extracted from appCommon so it
// is unit-testable with an Express double. The SSE view route subscribes to a
// run and forwards its events; closing the stream (client disconnect) only
// unsubscribes — the run keeps executing (background-completion).
import type { ReportRunManager } from "./runManager.js";

interface ExpressLike {
  post(path: string, ...handlers: unknown[]): void;
  get(path: string, ...handlers: unknown[]): void;
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

export function registerReportRoutes(app: ExpressLike, manager: ReportRunManager, guard: unknown): void {
  app.post("/api/report/run", guard, (req: { body?: unknown }, res: { status(c: number): { json(b: unknown): void }; json(b: unknown): void }) => {
    const { kind, paramsKey, params } = (req.body ?? {}) as { kind?: string; paramsKey?: string; params?: unknown };
    if (!kind || !paramsKey) { res.status(400).json({ error: "kind and paramsKey are required" }); return; }
    try {
      const { id, existing } = manager.start(kind, paramsKey, params);
      res.json({ id, existing });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/report/runs", guard, (_req: unknown, res: { json(b: unknown): void }) => {
    res.json({ runs: manager.list() });
  });

  app.get("/api/report/run/:id", guard, (req: { params: { id: string } }, res: { status(c: number): { json(b: unknown): void }; json(b: unknown): void }) => {
    const rec = manager.get(req.params.id);
    if (!rec) { res.status(404).json({ error: "not found" }); return; }
    res.json(rec);
  });

  app.get("/api/report/run/:id/stream", guard, (req: { params: { id: string }; on(ev: string, cb: () => void): void }, res: { writeHead(c: number, h: Record<string, string>): void; write(s: string): void; end(): void }) => {
    res.writeHead(200, { ...SSE_HEADERS });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const unsub = manager.subscribe(req.params.id, (e) => {
      if (e.type === "phase") send("phase", { phase: e.phase });
      else if (e.type === "delta") send("delta", { text: e.text });
      else if (e.type === "done") { send("done", { result: e.result }); res.end(); }
      else if (e.type === "failed") { send("failed", { error: e.error }); res.end(); }
    });
    req.on("close", () => unsub());
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/report/__tests__/routes.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire into `appCommon.ts`**

Add imports next to the existing warm/originGuard imports (near lines 53–56):

```ts
import { ReportRunManager } from "./report/runManager.js";
import { registerReportKinds } from "./report/kinds.js";
import { registerReportRoutes } from "./report/routes.js";
```

Immediately after the `/api/rubric/stream` route registration (after line 264), add:

```ts
  // Background report runs: start-or-attach, list, state, and a live SSE view over
  // one ReportRunManager per process. The manager owns each run's promise (never a
  // request), so navigating away can't abort it; runs are swept on completion and
  // periodically for TTL. Kinds: insights | rubric | analyze (see src/report/kinds).
  const reportRuns = new ReportRunManager();
  registerReportKinds(reportRuns);
  setInterval(() => reportRuns.sweep(), 60_000).unref();
  registerReportRoutes(server.expressApp as never, reportRuns, originGuard as never);
```

- [ ] **Step 6: Typecheck + full root suite**

Run: `npm run build && npx vitest run src/report`
Expected: build PASS; report tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/report/routes.ts src/report/__tests__/routes.test.ts src/appCommon.ts
git commit -m "feat(report): report run routes + appCommon wiring"
```

---

### Task 4: `useReportRun` client hook

Reattaches the latest run of a kind on mount; `start()` POSTs then opens the live SSE view. No localStorage — the server registry is the source of truth across reloads.

**Files:**
- Create: `packages/console/src/report/useReportRun.ts`
- Test: `packages/console/src/report/__tests__/useReportRun.test.tsx`

**Interfaces:**
- Consumes: the Task 3 routes.
- Produces:
  ```ts
  type RunStatus = "idle" | "queued" | "running" | "done" | "failed";
  interface ReportRunState<T> { id: string | null; params: unknown | null; status: RunStatus; phase: string; deltas: string; report: T | null; error: string | null }
  function useReportRun<T>(apiBase: string, kind: string): { state: ReportRunState<T>; start: (paramsKey: string, params: unknown) => void };
  ```

- [ ] **Step 1: Write the failing test**

```tsx
// packages/console/src/report/__tests__/useReportRun.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useReportRun } from "../useReportRun.js";

// A controllable EventSource double installed on globalThis.
class FakeES {
  static last: FakeES | null = null;
  listeners = new Map<string, (e: MessageEvent) => void>();
  closed = false;
  constructor(public url: string) { FakeES.last = this; }
  addEventListener(t: string, cb: (e: MessageEvent) => void) { this.listeners.set(t, cb); }
  close() { this.closed = true; }
  fire(t: string, data: unknown) { this.listeners.get(t)?.({ data: JSON.stringify(data) } as MessageEvent); }
}

beforeEach(() => {
  (globalThis as any).EventSource = FakeES as unknown;
  FakeES.last = null;
});

describe("useReportRun", () => {
  it("start() POSTs, opens the view, and folds phase/done into state", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ runs: [] }) })            // mount reattach: no runs
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "r1", existing: false }) }); // POST start
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useReportRun<{ n: number }>("http://x", "insights"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));   // mount poll done

    act(() => result.current.start("/p", { root: "/p" }));
    await waitFor(() => expect(result.current.state.id).toBe("r1"));
    expect(FakeES.last?.url).toContain("/api/report/run/r1/stream");

    act(() => FakeES.last!.fire("phase", { phase: "judging" }));
    expect(result.current.state.status).toBe("running");
    expect(result.current.state.phase).toBe("judging");

    act(() => FakeES.last!.fire("done", { result: { n: 42 } }));
    expect(result.current.state.status).toBe("done");
    expect(result.current.state.report).toEqual({ n: 42 });
  });

  it("reattaches the latest run of the kind on mount", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ runs: [{ id: "r9", kind: "insights", startedAt: 2 }, { id: "r8", kind: "rubric", startedAt: 3 }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "r9", params: { root: "/p" }, status: "running", phase: "judging" }) });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useReportRun("http://x", "insights"));
    await waitFor(() => expect(result.current.state.id).toBe("r9"));
    expect(result.current.state.status).toBe("running");
    expect(FakeES.last?.url).toContain("/api/report/run/r9/stream");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/console/src/report/__tests__/useReportRun.test.tsx`
Expected: FAIL — `Cannot find module '../useReportRun.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/console/src/report/useReportRun.ts
// A React hook that turns a report action into a background run. On mount it
// reattaches the latest run of `kind` (surviving navigation + reload, since the
// registry lives in the server process). `start()` POSTs to create/attach a run,
// then opens the live SSE view for phase/delta/done. Losing the view (unmount)
// never stops the run.
import { useEffect, useRef, useState } from "react";

export type RunStatus = "idle" | "queued" | "running" | "done" | "failed";

export interface ReportRunState<T> {
  id: string | null;
  params: unknown | null;
  status: RunStatus;
  phase: string;
  deltas: string;
  report: T | null;
  error: string | null;
}

interface RunView { id: string; kind: string; startedAt: number }
interface RunRecordView<T> { id: string; params: unknown; status: RunStatus; phase: string; result?: T; error?: string }

const IDLE = { id: null, params: null, status: "idle" as RunStatus, phase: "", deltas: "", report: null, error: null };

export function useReportRun<T>(apiBase: string, kind: string): {
  state: ReportRunState<T>;
  start: (paramsKey: string, params: unknown) => void;
} {
  const [state, setState] = useState<ReportRunState<T>>(IDLE);
  const esRef = useRef<EventSource | null>(null);

  const openView = (id: string) => {
    esRef.current?.close();
    const es = new EventSource(`${apiBase}/api/report/run/${encodeURIComponent(id)}/stream`);
    esRef.current = es;
    const data = (m: Event) => JSON.parse((m as MessageEvent).data);
    es.addEventListener("phase", (m) => { const d = data(m); setState((s) => ({ ...s, status: "running", phase: d.phase })); });
    es.addEventListener("delta", (m) => { const d = data(m); setState((s) => ({ ...s, deltas: s.deltas + d.text })); });
    es.addEventListener("done", (m) => { const d = data(m); setState((s) => ({ ...s, status: "done", phase: "done", report: d.result as T })); es.close(); });
    es.addEventListener("failed", (m) => { const d = data(m); setState((s) => ({ ...s, status: "failed", error: d.error })); es.close(); });
    es.addEventListener("error", () => { /* transient — keep last state */ });
  };

  const start = (paramsKey: string, params: unknown) => {
    setState({ ...IDLE, params, status: "queued", phase: "queued" });
    void fetch(`${apiBase}/api/report/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, paramsKey, params }) })
      .then((r) => r.json())
      .then(({ id }: { id: string }) => { setState((s) => ({ ...s, id })); openView(id); })
      .catch(() => setState((s) => ({ ...s, status: "failed", error: "failed to start run" })));
  };

  useEffect(() => {
    let cancelled = false;
    void fetch(`${apiBase}/api/report/runs`).then((r) => (r.ok ? r.json() : { runs: [] })).then(({ runs }: { runs: RunView[] }) => {
      if (cancelled) return;
      const mine = runs.filter((x) => x.kind === kind).sort((a, b) => b.startedAt - a.startedAt)[0];
      if (!mine) return;
      void fetch(`${apiBase}/api/report/run/${encodeURIComponent(mine.id)}`).then((r) => (r.ok ? r.json() : null)).then((rec: RunRecordView<T> | null) => {
        if (cancelled || !rec) return;
        if (rec.status === "done") setState({ id: rec.id, params: rec.params, status: "done", phase: "done", deltas: "", report: (rec.result ?? null) as T | null, error: null });
        else if (rec.status === "failed") setState({ id: rec.id, params: rec.params, status: "failed", phase: rec.phase, deltas: "", report: null, error: rec.error ?? "failed" });
        else { setState({ id: rec.id, params: rec.params, status: "running", phase: rec.phase, deltas: "", report: null, error: null }); openView(rec.id); }
      });
    });
    return () => { cancelled = true; esRef.current?.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase, kind]);

  return { state, start };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/console/src/report/__tests__/useReportRun.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/report/useReportRun.ts packages/console/src/report/__tests__/useReportRun.test.tsx
git commit -m "feat(console): useReportRun hook — start + reattach-latest"
```

---

### Task 5: `detectReportDone` + `ActivityProvider` + activity menu + Shell mount

The cross-app surface: poll the run list, fire the existing notify stack on new completions, render a bell dropdown that deep-links back.

**Files:**
- Modify: `packages/console/src/notify/events.ts` (add `detectReportDone`)
- Create: `packages/console/src/notify/ActivityProvider.tsx`
- Create: `packages/console/src/notify/ActivityMenu.tsx`
- Modify: `packages/console/src/shell/Shell.tsx` (mount provider; render menu next to `NotifyBell`)
- Modify: `packages/console/src/shell/theme.css` (activity menu rules)
- Test: `packages/console/src/notify/__tests__/reportEvents.test.ts`

**Interfaces:**
- Consumes: `dispatch`, `osNotify`, `readNotifyPref`, `useToast` (existing); the `GET /api/report/runs` route (Task 3).
- Produces:
  ```ts
  interface ReportSnapshot { terminal: Record<string, "done" | "failed">; kindOf: Record<string, string> }
  function detectReportDone(prev: ReportSnapshot | null, next: ReportSnapshot): NotifyEvent[];
  interface ActivityRun { id: string; kind: string; status: "queued" | "running" | "done" | "failed"; phase: string; startedAt: number }
  function useActivity(): { runs: ActivityRun[] };            // context hook
  function ActivityProvider(props: { apiBase: string; children: ReactNode }): ReactElement;
  function ActivityMenu(): ReactElement;
  ```

- [ ] **Step 1: Write the failing test (detector only — the provider/menu are browser-verified)**

```ts
// packages/console/src/notify/__tests__/reportEvents.test.ts
import { describe, it, expect } from "vitest";
import { detectReportDone, type ReportSnapshot } from "../events.js";

const snap = (terminal: Record<string, "done" | "failed">, kindOf: Record<string, string> = {}): ReportSnapshot => ({ terminal, kindOf });

describe("detectReportDone", () => {
  it("returns nothing on the first snapshot (no baseline)", () => {
    expect(detectReportDone(null, snap({ a: "done" }, { a: "insights" }))).toEqual([]);
  });

  it("fires one event per newly-terminal run", () => {
    const prev = snap({}, { a: "insights" });
    const next = snap({ a: "done" }, { a: "insights" });
    const evs = detectReportDone(prev, next);
    expect(evs).toHaveLength(1);
    expect(evs[0].title).toMatch(/Insights/);
    expect(evs[0].message).toMatch(/ready/);
  });

  it("does not re-fire for an already-terminal run", () => {
    const prev = snap({ a: "done" }, { a: "insights" });
    const next = snap({ a: "done", b: "failed" }, { a: "insights", b: "rubric" });
    const evs = detectReportDone(prev, next);
    expect(evs).toHaveLength(1);
    expect(evs[0].message).toMatch(/failed/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/console/src/notify/__tests__/reportEvents.test.ts`
Expected: FAIL — `detectReportDone` is not exported.

- [ ] **Step 3: Add `detectReportDone` to `events.ts`**

Append to `packages/console/src/notify/events.ts`:

```ts
export interface ReportSnapshot {
  terminal: Record<string, "done" | "failed">;   // run id -> its terminal status
  kindOf: Record<string, string>;                 // run id -> kind, for the message
}

const KIND_LABEL: Record<string, string> = { insights: "Insights", rubric: "Rubric", analyze: "Analysis" };

// One NotifyEvent per run that became terminal since `prev`. No baseline → nothing
// (avoids firing for runs that were already done when the app opened).
export function detectReportDone(prev: ReportSnapshot | null, next: ReportSnapshot): NotifyEvent[] {
  if (!prev) return [];
  const out: NotifyEvent[] = [];
  for (const [id, status] of Object.entries(next.terminal)) {
    if (prev.terminal[id]) continue;
    const label = KIND_LABEL[next.kindOf[id]] ?? "Report";
    out.push({
      key: `report-${id}`,
      title: status === "done" ? `${label} ready` : `${label} failed`,
      message: status === "done" ? `Your ${label.toLowerCase()} report finished.` : `Your ${label.toLowerCase()} report failed.`,
    });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/console/src/notify/__tests__/reportEvents.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Create `ActivityProvider.tsx`**

```tsx
// packages/console/src/notify/ActivityProvider.tsx
// Mounted once in Shell. Polls the report run list, exposes it via context for
// the activity menu, and fires the existing notify stack (toast + OS banner) when
// a run becomes terminal — mirroring NotificationsProvider's poll+detect+fire.
import { createContext, useContext, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { useToast } from "../shell/Toast.js";
import { dispatch } from "./dispatch.js";
import { osNotify } from "./osNotify.js";
import { readNotifyPref } from "./prefs.js";
import { detectReportDone, type ReportSnapshot } from "./events.js";

const POLL_MS = 5000;

export interface ActivityRun { id: string; kind: string; status: "queued" | "running" | "done" | "failed"; phase: string; startedAt: number }

const ActivityCtx = createContext<{ runs: ActivityRun[] }>({ runs: [] });
export const useActivity = () => useContext(ActivityCtx);

export function ActivityProvider({ apiBase, children }: { apiBase: string; children: ReactNode }): ReactElement {
  const { push } = useToast();
  const [runs, setRuns] = useState<ActivityRun[]>([]);
  const prev = useRef<ReportSnapshot | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch(`${apiBase}/api/report/runs`);
        if (!alive || !r.ok) return;
        const { runs: list } = (await r.json()) as { runs: ActivityRun[] };
        setRuns(list);
        const terminal: Record<string, "done" | "failed"> = {};
        const kindOf: Record<string, string> = {};
        for (const x of list) { kindOf[x.id] = x.kind; if (x.status === "done" || x.status === "failed") terminal[x.id] = x.status; }
        const next: ReportSnapshot = { terminal, kindOf };
        for (const ev of detectReportDone(prev.current, next)) {
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
// A bell/inbox button showing the count of active runs; the dropdown lists recent
// runs and deep-links back to each one's panel (the panel reattaches the latest
// run of its kind on mount). Sits next to NotifyBell in the shell header.
import { useState, type ReactElement } from "react";
import { useActivity, type ActivityRun } from "./ActivityProvider.js";

const ROUTE_FOR: Record<string, string> = { insights: "#/insights", rubric: "#/rubrics", analyze: "#/curate" };
const KIND_LABEL: Record<string, string> = { insights: "Insights", rubric: "Rubric", analyze: "Analysis" };

function label(r: ActivityRun): string {
  const kind = KIND_LABEL[r.kind] ?? r.kind;
  if (r.status === "running") return `${kind} — ${r.phase}`;
  if (r.status === "queued") return `${kind} — queued`;
  if (r.status === "failed") return `${kind} — failed`;
  return `${kind} — done`;
}

export function ActivityMenu(): ReactElement {
  const { runs } = useActivity();
  const [open, setOpen] = useState(false);
  const active = runs.filter((r) => r.status === "running" || r.status === "queued").length;

  const go = (r: ActivityRun) => {
    const route = ROUTE_FOR[r.kind];
    if (route) window.location.hash = route;
    setOpen(false);
  };

  return (
    <div className="activity-menu">
      <button
        type="button"
        className={"activity-toggle" + (active > 0 ? " is-active" : "")}
        aria-label={active > 0 ? `${active} running report${active === 1 ? "" : "s"}` : "Report activity"}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        🗂{active > 0 && <span className="activity-count">{active}</span>}
      </button>
      {open && (
        <div className="activity-pop" role="menu">
          {runs.length === 0
            ? <div className="activity-empty">No recent reports.</div>
            : runs.slice(0, 12).map((r) => (
                <button key={r.id} type="button" role="menuitem" className={"activity-row activity-" + r.status} onClick={() => go(r)}>
                  <span className={"activity-dot activity-dot-" + r.status} aria-hidden="true" />
                  {label(r)}
                </button>
              ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 7: Mount in `Shell.tsx`**

Add imports (near lines 8–9):
```tsx
import { ActivityProvider } from "../notify/ActivityProvider.js";
import { ActivityMenu } from "../notify/ActivityMenu.js";
```

Wrap the console tree with `ActivityProvider` — change the opening (line 154) and closing (line 209) so it sits inside `IdentityProvider` (it needs `useToast`, which `ToastProvider` supplies at the top):
```tsx
      <IdentityProvider apiBase={apiBase}>
      <ActivityProvider apiBase={apiBase}>
      <div
        className={"console" + ...}
        ...
```
and the matching close before `</IdentityProvider>`:
```tsx
      </div>
      </ActivityProvider>
      </IdentityProvider>
```

Render the menu next to the bell (line 171):
```tsx
            AgentGem
            <NotifyBell />
            <ActivityMenu />
```

- [ ] **Step 8: Add CSS to `theme.css`**

Append hand-authored rules using the existing design tokens (mirror `.notify-bell`):
```css
.activity-menu { position: relative; display: inline-flex; }
.activity-toggle { background: none; border: 0; cursor: pointer; font-size: 15px; padding: 2px 4px; position: relative; opacity: .7; }
.activity-toggle:hover, .activity-toggle.is-active { opacity: 1; }
.activity-count { position: absolute; top: -2px; right: -4px; min-width: 14px; height: 14px; padding: 0 3px; border-radius: 7px; background: var(--brand); color: #fff; font-size: 10px; line-height: 14px; text-align: center; }
.activity-pop { position: absolute; top: 100%; right: 0; z-index: 30; margin-top: 4px; min-width: 240px; background: var(--surface); border: 1px solid var(--ink-10, rgba(0,0,0,.12)); border-radius: 8px; box-shadow: 0 6px 24px rgba(0,0,0,.18); padding: 4px; }
.activity-empty { padding: 10px 12px; color: var(--ink-60, #666); font-size: 13px; }
.activity-row { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; background: none; border: 0; cursor: pointer; padding: 8px 10px; border-radius: 6px; font-size: 13px; color: var(--ink); }
.activity-row:hover { background: var(--ink-05, rgba(0,0,0,.05)); }
.activity-dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; }
.activity-dot-running, .activity-dot-queued { background: var(--brand); }
.activity-dot-done { background: #2e9e5b; }
.activity-dot-failed { background: #d24b4b; }
```
(If a token like `--ink-10` isn't defined in `theme.css`, use the rgba fallback shown; confirm with `grep -n "\-\-ink" packages/console/src/shell/theme.css` and match existing token names.)

- [ ] **Step 9: Typecheck + tests**

Run: `cd packages/console && npx tsc --noEmit && npx vitest run src/notify`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/console/src/notify/events.ts packages/console/src/notify/ActivityProvider.tsx packages/console/src/notify/ActivityMenu.tsx packages/console/src/notify/__tests__/reportEvents.test.ts packages/console/src/shell/Shell.tsx packages/console/src/shell/theme.css
git commit -m "feat(console): report-done notifications + activity menu"
```

---

### Task 6: Insights panel retrofit (the working proof)

Swap the bespoke `generate()` + stream state for `useReportRun`. This is the end-to-end proof: run Insights, navigate away, get notified, come back and see it.

**Files:**
- Modify: `packages/console/src/panels/Insights/index.tsx`

**Interfaces:**
- Consumes: `useReportRun` (Task 4). The insights run's `report` is `InsightsRunResult = { report: InsightsReportView; degraded: boolean; scanned: number | null; updatedAt: number | null }` (Task 2).

- [ ] **Step 1: Replace state + generate with the hook**

Remove the imports of `openInsightsStream` usage remnants is unnecessary (keep `InsightsReportView` type import from `./insightsStream.js`). Add:
```tsx
import { useReportRun } from "../../report/useReportRun.js";
```
Define the run result type near the top of the file (after imports):
```tsx
interface InsightsRunResult { report: InsightsReportView; degraded: boolean; scanned: number | null; updatedAt: number | null }
```

Replace the streaming state block (`index.tsx:33-42`, i.e. `phase/out/report/updatedAt/scanned/degraded/error/running/closeRef`) and the two effects/`generate` (`:44-60`) with:
```tsx
  const [projects, setProjects] = useState<ProjectCandidate[] | null>(null);
  const [recents, setRecents] = useState<RecentEntry[] | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const { state, start } = useReportRun<InsightsRunResult>(apiBase, "insights");

  useEffect(() => {
    const client = makeClient(apiBase);
    testbedProjectsRoute.call(client).then((r) => setProjects(r.projects)).catch(() => setProjects([]));
    testbedRecentsRoute.call(client).then((r) => setRecents(r.recents)).catch(() => setRecents([]));
  }, [apiBase]);

  // Reattached a run on mount (e.g. came back after navigating away) → select its row.
  useEffect(() => {
    const root = (state.params as { root?: string } | null)?.root;
    if (root && !activePath) setActivePath(root);
  }, [state.params, activePath]);

  const generate = (path: string, fresh = false) => {
    setActivePath(path);
    start(path, { root: path, fresh });
  };
```
Note: `paramsKey` for insights is just the project path (`start(path, { root: path, fresh })`).

- [ ] **Step 2: Update the render to read from `state`**

Derive the view fields from the hook. Replace the row's status/report block (`index.tsx:100-141`) references:
- `running` → `const running = state.status === "queued" || state.status === "running";`
- `phase` → `state.phase`
- `error` → `state.error`
- `out` (live deltas) → `state.deltas`
- `report` → `state.report?.report ?? null`
- `updatedAt` → `state.report?.updatedAt ?? null`
- `scanned` → `state.report?.scanned ?? null`
- `degraded` → `state.report?.degraded ?? false`

Concretely, add just above the `return`:
```tsx
  const running = state.status === "queued" || state.status === "running";
  const report = state.report?.report ?? null;
  const updatedAt = state.report?.updatedAt ?? null;
  const scanned = state.report?.scanned ?? null;
  const degraded = state.report?.degraded ?? false;
  const phase = state.phase;
  const error = state.error;
  const out = state.deltas;
```
The existing JSX (`:100-141`) then compiles unchanged, because it already references `running`, `report`, `updatedAt`, `scanned`, `degraded`, `phase`, `error`, `out`. The row button `disabled={running}` and `onClick={() => generate(r.path)}` stay. `Re-run ↻` stays `onClick={() => generate(r.path, true)}`.

- [ ] **Step 3: Typecheck**

Run: `cd packages/console && npx tsc --noEmit`
Expected: PASS. (If TS complains that `report` is possibly the old `InsightsReportView` vs new — ensure `InsightsReportCard report={report}` still receives `InsightsReportView`; `state.report?.report` is exactly that type.)

- [ ] **Step 4: Manual browser verification (required — jsdom can't prove this)**

Run the console against a project with session history. Verify end-to-end:
1. Click **Insights →** on a project → live phase/`run-transcript` deltas stream as before.
2. While it runs, navigate to another panel (e.g. Sessions). The `🗂` activity menu shows `1` and lists "Insights — <phase>".
3. On completion (with notifications enabled) a toast fires; if the window is backgrounded, an OS banner fires.
4. Return to **Insights** → the previously-run project row is selected and shows the finished report (loaded from the run record). The activity menu lists "Insights — done".
5. Open the activity menu entry → navigates to `#/insights` and shows the same report.

Document the run command you used (per the repo's `run` skill) in the commit body.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/panels/Insights/index.tsx
git commit -m "feat(console): Insights runs in the background via useReportRun"
```

---

### Task 7: Rubrics panel retrofit

**Files:**
- Read first: `packages/console/src/panels/Rubrics/index.tsx` and `packages/console/src/panels/Rubrics/rubricStream.ts` (to see the current scope selection + `openRubricStream` usage — the same `generate()`-closes-stream idiom as Insights).
- Modify: `packages/console/src/panels/Rubrics/index.tsx`

**Interfaces:**
- Consumes: `useReportRun` (Task 4). The rubric run's `report` is `RubricRunResult = { report: RubricReportView; updatedAt: number | null }`. `paramsKey` = `` `${rubric}:${scope.kind}:${scope.root ?? ""}:${scope.sessionId ?? ""}` ``.

- [ ] **Step 1: Swap the stream driver for the hook**

Add `import { useReportRun } from "../../report/useReportRun.js";` and define:
```tsx
interface RubricRunResult { report: RubricReportView; updatedAt: number | null }
```
Replace the panel's streaming `useState` (report/phase/deltas/running/error/updatedAt/cached) + its `openRubricStream` driver with:
```tsx
  const { state, start } = useReportRun<RubricRunResult>(apiBase, "rubric");
```
Rewrite the panel's "run" handler (the one that today calls `openRubricStream(apiBase, params, onEvent, fresh)`) to:
```tsx
  const run = (params: { rubric: string; scope: "all" | "project" | "session"; root?: string; sessionId?: string }, fresh = false) => {
    const scope = params.scope === "all"
      ? { kind: "all" as const }
      : params.scope === "project"
        ? { kind: "project" as const, root: params.root! }
        : { kind: "session" as const, root: params.root!, sessionId: params.sessionId! };
    const key = `${params.rubric}:${scope.kind}:${(scope as { root?: string }).root ?? ""}:${(scope as { sessionId?: string }).sessionId ?? ""}`;
    start(key, { rubric: params.rubric, scope, fresh });
  };
```
Map the render fields exactly as Insights: `running = state.status === "queued" || state.status === "running"`, `report = state.report?.report ?? null`, `updatedAt = state.report?.updatedAt ?? null`, `phase = state.phase`, `error = state.error`, live deltas = `state.deltas`. Keep the existing report-card component and scope selectors untouched.

- [ ] **Step 2: Typecheck**

Run: `cd packages/console && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Manual browser verification**

Run a rubric at a scope; navigate away mid-run; confirm the activity menu shows "Rubric — <phase>", a completion notification fires, and returning to Rubrics re-shows the report.

- [ ] **Step 4: Commit**

```bash
git add packages/console/src/panels/Rubrics/index.tsx
git commit -m "feat(console): Rubric evaluation runs in the background"
```

---

### Task 8: Curate Analyze panel retrofit

**Files:**
- Read first: `packages/console/src/panels/Curate/Analyze.tsx` and `packages/console/src/panels/Curate/analyzeStream.ts`.
- Modify: `packages/console/src/panels/Curate/Analyze.tsx`

**Interfaces:**
- Consumes: `useReportRun` (Task 4). Unlike insights/rubric, the analyze `done` payload spreads `candidates` (there is no single `report` object — see `analyzeStream.ts`: `done` carries `candidates: AnalyzeCandidate[]`). The analyze run's result is `AnalyzeRunResult = { report: { candidates: AnalyzeCandidate[] }; updatedAt: number | null }` (the runner in Task 2 returns the server `WorkflowAnalysisPayload`, whose `candidates` field is what the panel reads). `paramsKey` = the project root.

- [ ] **Step 1: Swap the stream driver for the hook**

Add imports:
```tsx
import { useReportRun } from "../../report/useReportRun.js";
import type { AnalyzeCandidate } from "./analyzeStream.js";
```
Define the run-result type (structural — only `candidates` is consumed):
```tsx
interface AnalyzeRunResult { report: { candidates: AnalyzeCandidate[] }; updatedAt: number | null }
```
Replace the streaming `useState` + `openAnalyzeStream` driver with:
```tsx
  const { state, start } = useReportRun<AnalyzeRunResult>(apiBase, "analyze");
  const analyze = (root: string, fresh = false) => start(root, { root, fresh });
```
Map render fields (note analyze renders `candidates`, not a `report` object):
```tsx
  const running = state.status === "queued" || state.status === "running";
  const candidates = state.report?.report?.candidates ?? [];
  const updatedAt = state.report?.updatedAt ?? null;
  const phase = state.phase;
  const error = state.error;
  const out = state.deltas;
```
Keep the Analyze result UI (it already renders `candidates`) and the `consumePendingAnalyze()` hand-off (Insights → Curate): if a pending root is consumed on mount, call `analyze(root)` as it does today. If the current UI showed candidates only when non-empty, keep that guard against `candidates.length`.

- [ ] **Step 2: Typecheck**

Run: `cd packages/console && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Manual browser verification**

From Insights, click "Build a Gem from this project →" (hands off to Curate/Analyze); confirm analysis runs, survives navigation, notifies, and re-shows on return. Also run Analyze directly.

- [ ] **Step 4: Commit**

```bash
git add packages/console/src/panels/Curate/Analyze.tsx
git commit -m "feat(console): Curate analysis runs in the background"
```

---

### Task 9: Full suite + PR

**Files:** none (verification + integration).

- [ ] **Step 1: Root suite (CI-gated)**

Run: `cd /Users/rfeng/Projects/ninemind/agentgem-worktrees/async-report-runs && npm run build && npx vitest run src`
Expected: PASS (includes `src/report/**`).

- [ ] **Step 2: Console suite (local — not in CI)**

Run: `cd packages/console && npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 3: Push + PR**

```bash
git push -u origin feat/async-report-runs
gh pr create --title "Background report runs (Insights, Rubric, Analyze)" --body "$(cat <<'BODY'
Generalizes the ChatManager durable-session pattern to agent-backed report
generation. Report SSE becomes a view onto a run owned by a sequential in-memory
ReportRunManager, so a client disconnect can't abort the work. Adds notify-on-done
via the existing notify stack and a Bell-adjacent activity menu that deep-links
back to each run's panel. Wires Insights, Rubric, and Analyze.

Scorecard (not agent-backed; already SWR) and gem-run (an execution with no compute
core to wrap) are deliberately out of scope — see docs/superpowers/specs/2026-07-13-background-report-runs-design.md.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

- [ ] **Step 4: Watch CI, merge when green**

```bash
gh run watch <run-id> --exit-status && gh pr merge --rebase --delete-branch
```
Then verify each commit's content is on `origin/main` (grep `origin/main:src/report/runManager.ts` for `class ReportRunManager`, and `origin/main:packages/console/src/report/useReportRun.ts` for `useReportRun`), per the repo's dropped-commit trap.

---

## Deferred (documented, not in this plan)

- **Scorecard (Mine):** not agent-backed (`collectScorecard` is a pure sync scan) and already stale-while-revalidate. If uniformity is later wanted, add a `scorecard` runner wrapping `collectScorecard(dir, projects, Date.now(), { onProgress })` — but there is no user-facing gap today.
- **Gem-run (Optimize):** an *execution*, not a read-only report; `streamGemRun` drives SSE directly with no `{payload,cached,updatedAt}` core. Backgrounding it needs a compute-core extraction first — its own spec.
