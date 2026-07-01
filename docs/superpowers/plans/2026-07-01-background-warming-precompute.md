# Background Warming for the Precompute Layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A trigger-agnostic background job that proactively warms the on-disk precompute caches (usage, scorecard, insights, workflow-analysis) so console panels load from cache instead of recomputing on demand, with force-redo already wired through the existing Re-run/Re-scan controls.

**Architecture:** Extract headless, cache-aware `compute*` cores from the two LLM SSE stream handlers (insights, workflow-analyze); the SSE endpoints become thin wrappers over those cores, and a new warm orchestrator calls the same cores plus the already-pure `computeGlobalUsage`/`collectScorecard` helpers. One `runWarmPass()` engine is driven now by an in-process schedule (server boot + idle timer) and later by a daemon (out of scope). LLM warming is bounded to the top-N most-recently-active projects and skips while a foreground compute is in flight.

**Tech Stack:** TypeScript (ESM, `node:` built-ins), Vitest, the `@agentgem/*` workspace packages (`@agentgem/insight`, `@agentgem/capture`, `@agentgem/model`), Express (`server.expressApp`, duck-typed), React (`packages/console`).

## Global Constraints

- **Best-effort, never throws:** every cache read/write and every warm step must swallow its own errors; a failure logs and the pass continues. Matches the existing cache ethos.
- **Never block server boot:** the warm schedule is fire-and-forget after `app.start()`.
- **Console-only:** warming runs only when `process.env.SERVE_CONSOLE !== "false"` (the local desktop app), never on the hosted public API.
- **Don't cache degraded results:** preserve the existing rule — insights/analyze payloads with `degraded: true` and scorecards with `.degraded === true` are returned but NOT written to cache.
- **Cost bound:** LLM warmables run only for the top-N most-recently-active projects; default **N = 5**. Cheap/global warmables run once per pass.
- **LLM warms run serially** (one at a time) and are skipped for the current pass when a foreground compute is in flight.
- **Test isolation:** never scan the real `~/.claude` in tests. Set `process.env.AGENTGEM_HOME` to a `mkdtempSync` dir and/or inject deps; restore env in `afterEach`.
- **Copyright header:** every new `.ts` file starts with the two existing header lines:
  `// Copyright (c) 2026 NineMind, Inc.` / `// SPDX-License-Identifier: MIT`.
- **Git identity for commits:** `Raymond Feng <raymond@ninemind.ai>` (use `git -c user.name=... -c user.email=...`).

## Warmable inventory (the exact v1 set)

| id | cost | scope | compute (already pure unless noted) | cache | key |
|---|---|---|---|---|---|
| `usage` | cheap | global | `computeGlobalUsage(dirs, paths)` | usageCache | `transcriptToken(allClaudeTranscripts)` |
| `scorecard` | cheap | aggregate (all roots, one entry) | `collectScorecard(dir, undefined, now)` | analysisCache | `(SCORECARD_CACHE_ROOT, token)` |
| `insights` | llm | per-root (top-N) | **`computeInsights(root)` — extracted in Task 2** | insightsCache | `(root, token)` |
| `analyze` | llm | per-root (top-N) | **`computeWorkflowAnalysis(root)` — extracted in Task 3** | analysisCache | `(root, token)` |

Excluded from v1: **observe** (cheap + already memoized in-process). Deferred fast-follow: **distill** (heterogeneous MCP-dispatch shape — needs its own cache/core first).

---

## Task 1: Cache-entry timestamp accessors

Adds `readInsightsCacheEntry` / `readAnalysisCacheEntry` returning `{ result, ts }` so the cores can report "updated Xm ago". The existing `readInsightsCache`/`readAnalysisCache` (result-only) stay unchanged.

**Files:**
- Modify: `packages/insight/src/insightsCache.ts`
- Modify: `packages/insight/src/analysisCache.ts`
- Modify: `packages/insight/src/index.ts` (re-export the two new fns)
- Test: `src/gem/__tests__/insightsCache.test.ts` (new file — sibling of the existing analysisCache.test.ts)

**Interfaces:**
- Produces:
  - `readInsightsCacheEntry(root: string, token: string): { result: unknown; ts: number } | null`
  - `readAnalysisCacheEntry(root: string, token: string): { result: unknown; ts: number } | null`

- [ ] **Step 1: Write the failing test**

Create `src/gem/__tests__/insightsCache.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeInsightsCache, readInsightsCache, readInsightsCacheEntry,
} from "@agentgem/insight";

const orig = process.env.AGENTGEM_HOME;
afterEach(() => { if (orig === undefined) delete process.env.AGENTGEM_HOME; else process.env.AGENTGEM_HOME = orig; });

describe("readInsightsCacheEntry", () => {
  it("returns { result, ts } for a hit and null for a miss", () => {
    process.env.AGENTGEM_HOME = mkdtempSync(join(tmpdir(), "ic-"));
    writeInsightsCache("/proj", "tok", { hello: "world" }, 1234);
    expect(readInsightsCache("/proj", "tok")).toEqual({ hello: "world" });
    expect(readInsightsCacheEntry("/proj", "tok")).toEqual({ result: { hello: "world" }, ts: 1234 });
    expect(readInsightsCacheEntry("/proj", "other-token")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/gem/__tests__/insightsCache.test.ts`
Expected: FAIL — `readInsightsCacheEntry is not a function` (not exported yet).

- [ ] **Step 3: Add the accessor to `insightsCache.ts`**

Append to `packages/insight/src/insightsCache.ts` (after `readInsightsCache`):

```ts
/** Cached entry (result + write timestamp) for (root, token), or null on miss/stale. */
export function readInsightsCacheEntry(root: string, token: string): { result: unknown; ts: number } | null {
  const e = readAll().find((x) => x.root === root && x.token === token);
  return e ? { result: e.result, ts: e.ts } : null;
}
```

Add the mirror to `packages/insight/src/analysisCache.ts` (after `readAnalysisCache`):

```ts
/** Cached entry (result + write timestamp) for (root, token), or null on miss/stale. */
export function readAnalysisCacheEntry(root: string, token: string): { result: unknown; ts: number } | null {
  const e = readAll().find((x) => x.root === root && x.token === token);
  return e ? { result: e.result, ts: e.ts } : null;
}
```

- [ ] **Step 4: Re-export from the package index**

In `packages/insight/src/index.ts`, find the line that re-exports the insights/analysis cache symbols and add the two new names to those export lists (e.g. alongside `readInsightsCache` and `readAnalysisCache`). If they are exported via `export * from "./insightsCache.js"` / `"./analysisCache.js"`, no change is needed — verify with:

Run: `grep -n "insightsCache\|analysisCache" packages/insight/src/index.ts`
If the exports are explicit named lists, add `readInsightsCacheEntry` / `readAnalysisCacheEntry` to them.

- [ ] **Step 5: Rebuild the package and run the test to verify it passes**

Run: `pnpm -w build && pnpm vitest run src/gem/__tests__/insightsCache.test.ts`
Expected: PASS. (The `@agentgem/*` imports resolve to `dist/`, so the package must be rebuilt — see the "test-setup runs compiled dist" convention.)

- [ ] **Step 6: Commit**

```bash
git add packages/insight/src/insightsCache.ts packages/insight/src/analysisCache.ts packages/insight/src/index.ts src/gem/__tests__/insightsCache.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(insight): cache-entry accessors exposing write timestamp for freshness UI"
```

---

## Task 2: Extract the headless `computeInsights` core

Pulls the compute+cache logic out of `streamInsights` into a headless core that the SSE endpoint AND the warmer both call. Progress is delivered via optional callbacks (the warmer passes none).

**Files:**
- Create: `src/insightsCore.ts`
- Modify: `src/insightsStream.ts` (becomes a thin transport wrapper)
- Test: `src/__tests__/insightsCore.test.ts`

**Interfaces:**
- Consumes: `readInsightsCacheEntry` (Task 1).
- Produces:
  - `interface InsightsProgress { onPhase?(phase: string, extra?: Record<string, unknown>): void; onDelta?(text: string): void }`
  - `interface InsightsResult { payload: InsightsPayload; cached: boolean; updatedAt: number | null }`
  - `computeInsights(root: string, opts?: { dir?: string; force?: boolean; progress?: InsightsProgress; now?: () => number }): Promise<InsightsResult>`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/insightsCore.test.ts`. It exercises the cache-hit path without invoking the agent by pre-seeding the cache with the same token the core will compute:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insightsToken, writeInsightsCache, claudeTranscriptsForCwd } from "@agentgem/insight";
import { computeInsights } from "../insightsCore.js";

const orig = { home: process.env.AGENTGEM_HOME };
afterEach(() => {
  if (orig.home === undefined) delete process.env.AGENTGEM_HOME; else process.env.AGENTGEM_HOME = orig.home;
});

describe("computeInsights", () => {
  it("returns the cached payload without recomputing when the token matches", async () => {
    const home = mkdtempSync(join(tmpdir(), "ins-"));
    process.env.AGENTGEM_HOME = home;
    // A claudeDir with one transcript for project root /proj so the token is stable.
    const claudeDir = join(home, ".claude");
    const projDir = join(claudeDir, "projects", "-proj");
    mkdirSync(projDir, { recursive: true });
    const f = join(projDir, "s.jsonl");
    writeFileSync(f, JSON.stringify({ cwd: "/proj" }) + "\n");

    const paths = claudeTranscriptsForCwd(claudeDir, "/proj");
    const token = insightsToken(paths);
    const payload = { report: { totals: {} }, facets: [], degraded: false, signalSummary: { sessionsScanned: 1, spanDays: 0, notes: [] } };
    writeInsightsCache("/proj", token, payload, 777);

    const res = await computeInsights("/proj", { dir: claudeDir });
    expect(res.cached).toBe(true);
    expect(res.updatedAt).toBe(777);
    expect((res.payload.report as { totals: unknown }).totals).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/insightsCore.test.ts`
Expected: FAIL — cannot find module `../insightsCore.js`.

- [ ] **Step 3: Write `src/insightsCore.ts`**

Move the compute logic out of `streamInsights` (current lines 42–87) into the core. Phase/delta `send()` calls become optional `progress` callbacks:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/insightsCore.ts
//
// Headless, cache-aware core for the personal session-insights report. Both the
// SSE endpoint (src/insightsStream.ts) and the background warmer call this so
// they cache identically. Progress is optional callbacks; the warmer passes none.
import { introspectConfig, introspectProject } from "@agentgem/capture";
import { resolveDirs, resolveProject } from "@agentgem/model";
import {
  claudeTranscriptsForCwd, allClaudeTranscripts, scanWorkflow,
  judgeSessions, synthesizeInsights, narrateInsights,
  insightsToken, readInsightsCacheEntry, writeInsightsCache,
} from "@agentgem/insight";

export interface InsightsPayload {
  report: ReturnType<typeof synthesizeInsights>;
  facets: Awaited<ReturnType<typeof judgeSessions>>["facets"];
  degraded: boolean;
  signalSummary: { sessionsScanned: number; spanDays: number; notes: unknown };
}
export interface InsightsProgress {
  onPhase?(phase: string, extra?: Record<string, unknown>): void;
  onDelta?(text: string): void;
}
export interface InsightsResult { payload: InsightsPayload; cached: boolean; updatedAt: number | null }

export async function computeInsights(
  root: string,
  opts: { dir?: string; force?: boolean; progress?: InsightsProgress; now?: () => number } = {},
): Promise<InsightsResult> {
  const now = opts.now ?? Date.now;
  const p = opts.progress;
  const dirs = resolveDirs(opts.dir);
  const allProjects = root === "*";
  const scanInv = allProjects
    ? { project: { root: "*", name: "All projects", skills: [], mcpServers: [], hooks: [], instructions: [] } }
    : (() => {
        const project = introspectProject(resolveProject(root));
        const globalInv = introspectConfig(dirs);
        return { project, global: { skills: globalInv.skills, mcpServers: globalInv.mcpServers, hooks: globalInv.hooks } };
      })();

  p?.onPhase?.("scanning");
  const paths = allProjects ? allClaudeTranscripts(dirs.claudeDir) : claudeTranscriptsForCwd(dirs.claudeDir, root);
  const token = insightsToken(paths);

  if (!opts.force) {
    const entry = readInsightsCacheEntry(root, token);
    if (entry) return { payload: entry.result as InsightsPayload, cached: true, updatedAt: entry.ts };
  }

  const signal = scanWorkflow(paths, scanInv, { retainSequences: true });
  p?.onPhase?.("scanned", { transcripts: paths.length, sessions: signal.sessions.scanned });

  p?.onPhase?.("judging");
  const { facets, degraded: judgeDegraded } = await judgeSessions(signal, { onDelta: (chunk) => p?.onDelta?.(chunk) });

  p?.onPhase?.("synthesizing");
  const report = synthesizeInsights(facets);

  p?.onPhase?.("narrating");
  const narr = await narrateInsights(facets, report.narrative, { onDelta: (chunk) => p?.onDelta?.(chunk) });
  report.narrative = narr.narrative;

  const payload: InsightsPayload = {
    report, facets,
    degraded: judgeDegraded || narr.degraded,
    signalSummary: { sessionsScanned: signal.sessions.scanned, spanDays: signal.sessions.spanDays, notes: signal.notes },
  };
  let updatedAt: number | null = null;
  if (!payload.degraded) { const ts = now(); writeInsightsCache(root, token, payload, ts); updatedAt = ts; }
  return { payload, cached: false, updatedAt };
}
```

- [ ] **Step 4: Refactor `streamInsights` to wrap the core**

Replace the body of `src/insightsStream.ts` (keep the `SseReq`/`SseRes` types and the SSE header/`send` setup) so the compute is delegated:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/insightsStream.ts
//
// SSE transport wrapper over computeInsights (src/insightsCore.ts). All compute
// + caching lives in the core so the endpoint and the background warmer stay in
// sync. Registered raw on expressApp because the decorator framework only
// returns single JSON bodies.
import { computeInsights } from "./insightsCore.js";

interface SseReq { query: Record<string, unknown> }
interface SseRes {
  writeHead(status: number, headers: Record<string, string>): void;
  write(chunk: string): void;
  end(): void;
}

export async function streamInsights(req: SseReq, res: SseRes): Promise<void> {
  const root = typeof req.query.root === "string" ? req.query.root : "";
  const dir = typeof req.query.dir === "string" ? req.query.dir : undefined;
  const fresh = req.query.fresh === "1";   // bypass the cache (Re-run)

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    if (!root) { send("failed", { message: "missing root" }); return; }
    const { payload, cached, updatedAt } = await computeInsights(root, {
      dir, force: fresh,
      progress: {
        onPhase: (phase, extra) => send("phase", { phase, ...(extra ?? {}) }),
        onDelta: (text) => send("delta", { text }),
      },
    });
    send("done", { ...payload, cached, updatedAt });
  } catch (err) {
    send("failed", { message: (err as Error)?.message ?? String(err) });
  } finally {
    res.end();
  }
}
```

- [ ] **Step 5: Run tests to verify pass (core + existing insights tests)**

Run: `pnpm -w build && pnpm vitest run src/__tests__/insightsCore.test.ts src/gem/__tests__/insightsReport.test.ts src/gem/__tests__/narrateInsights.test.ts`
Expected: PASS. (Rebuild first — the core imports from `@agentgem/insight` dist.)

- [ ] **Step 6: Commit**

```bash
git add src/insightsCore.ts src/insightsStream.ts src/__tests__/insightsCore.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "refactor(insights): extract headless computeInsights core; stream wraps it"
```

---

## Task 3: Extract the headless `computeWorkflowAnalysis` core

Same pattern for the Curate workflow analysis (the other LLM per-root path).

**Files:**
- Create: `src/workflowCore.ts`
- Modify: `src/workflowStream.ts` (thin wrapper)
- Test: `src/__tests__/workflowCore.test.ts`

**Interfaces:**
- Consumes: `readAnalysisCacheEntry` (Task 1).
- Produces:
  - `interface WorkflowAnalysisPayload { candidates: unknown[]; gaps: string[]; distilled: unknown; reflections: unknown[]; signalSummary: { sessionsScanned: number; spanDays: number; notes: unknown }; degraded: boolean }`
  - `interface WorkflowAnalysisResult { payload: WorkflowAnalysisPayload; cached: boolean; updatedAt: number | null }`
  - `computeWorkflowAnalysis(root: string, opts?: { dir?: string; force?: boolean; progress?: { onPhase?(phase: string, extra?: Record<string, unknown>): void; onDelta?(text: string): void }; now?: () => number }): Promise<WorkflowAnalysisResult>`

- [ ] **Step 1: Write the failing test** (cache-hit path, no agent)

Create `src/__tests__/workflowCore.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcriptToken, writeAnalysisCache, claudeTranscriptsForCwd } from "@agentgem/insight";
import { computeWorkflowAnalysis } from "../workflowCore.js";

const orig = process.env.AGENTGEM_HOME;
afterEach(() => { if (orig === undefined) delete process.env.AGENTGEM_HOME; else process.env.AGENTGEM_HOME = orig; });

describe("computeWorkflowAnalysis", () => {
  it("returns the cached payload without running the agent when the token matches", async () => {
    const home = mkdtempSync(join(tmpdir(), "wf-"));
    process.env.AGENTGEM_HOME = home;
    const claudeDir = join(home, ".claude");
    const projDir = join(claudeDir, "projects", "-proj");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, "s.jsonl"), JSON.stringify({ cwd: "/proj" }) + "\n");

    const token = transcriptToken(claudeTranscriptsForCwd(claudeDir, "/proj"));
    const payload = { candidates: [], gaps: [], distilled: null, reflections: [], signalSummary: { sessionsScanned: 1, spanDays: 0, notes: [] }, degraded: false };
    writeAnalysisCache("/proj", token, payload, 555);

    const res = await computeWorkflowAnalysis("/proj", { dir: claudeDir });
    expect(res.cached).toBe(true);
    expect(res.updatedAt).toBe(555);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/workflowCore.test.ts`
Expected: FAIL — cannot find module `../workflowCore.js`.

- [ ] **Step 3: Write `src/workflowCore.ts`** (move logic from `streamWorkflowAnalyze` lines 44–89)

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/workflowCore.ts
//
// Headless, cache-aware core for the Curate workflow analysis. Shared by the SSE
// endpoint (src/workflowStream.ts) and the background warmer.
import { introspectConfig, introspectProject } from "@agentgem/capture";
import { resolveDirs, resolveProject } from "@agentgem/model";
import {
  claudeTranscriptsForCwd, scanWorkflow,
  recommendWorkflow, recommendationToSelection, distillWorkflow,
  extractReflections, writeReflections,
  transcriptToken, readAnalysisCacheEntry, writeAnalysisCache,
} from "@agentgem/insight";

export interface WorkflowAnalysisPayload {
  candidates: unknown[]; gaps: string[]; distilled: unknown; reflections: unknown[];
  signalSummary: { sessionsScanned: number; spanDays: number; notes: unknown };
  degraded: boolean;
}
export interface WorkflowAnalysisResult { payload: WorkflowAnalysisPayload; cached: boolean; updatedAt: number | null }

export async function computeWorkflowAnalysis(
  root: string,
  opts: {
    dir?: string; force?: boolean; now?: () => number;
    progress?: { onPhase?(phase: string, extra?: Record<string, unknown>): void; onDelta?(text: string): void };
  } = {},
): Promise<WorkflowAnalysisResult> {
  const now = opts.now ?? Date.now;
  const p = opts.progress;
  const dirs = resolveDirs(opts.dir);
  const project = introspectProject(resolveProject(root));
  const globalInv = introspectConfig(dirs);
  const scanInv = { project, global: { skills: globalInv.skills, mcpServers: globalInv.mcpServers, hooks: globalInv.hooks } };

  p?.onPhase?.("scanning");
  const paths = claudeTranscriptsForCwd(dirs.claudeDir, root);
  const token = transcriptToken(paths);
  if (!opts.force) {
    const entry = readAnalysisCacheEntry(root, token);
    if (entry) return { payload: entry.result as WorkflowAnalysisPayload, cached: true, updatedAt: entry.ts };
  }

  const signal = scanWorkflow(paths, scanInv, { retainSequences: true });
  p?.onPhase?.("scanned", { transcripts: paths.length, sessions: signal.sessions.scanned });

  p?.onPhase?.("thinking");
  const [{ analysis, degraded }, distill] = await Promise.all([
    recommendWorkflow(signal, scanInv, { onDelta: (chunk) => p?.onDelta?.(chunk) }),
    distillWorkflow(signal, scanInv),
  ]);

  p?.onPhase?.("validating");
  const reflections = extractReflections(signal);
  writeReflections(reflections, root);   // best-effort; ignore the path
  const gaps = [...analysis.gaps, ...reflections.filter((r) => r.importance === "high").map((r) => r.detail)];
  const candidates = analysis.candidates.map((c) => ({ ...c, selection: recommendationToSelection(c) }));
  const anyDegraded = degraded || distill.degraded;
  const payload: WorkflowAnalysisPayload = {
    candidates, gaps, distilled: distill.distilled, reflections,
    signalSummary: { sessionsScanned: signal.sessions.scanned, spanDays: signal.sessions.spanDays, notes: signal.notes },
    degraded: anyDegraded,
  };
  let updatedAt: number | null = null;
  if (!anyDegraded) { const ts = now(); writeAnalysisCache(root, token, payload, ts); updatedAt = ts; }
  return { payload, cached: false, updatedAt };
}
```

- [ ] **Step 4: Refactor `streamWorkflowAnalyze` to wrap the core**

Replace the compute body of `src/workflowStream.ts` (keep `SseReq`/`SseRes` + header/`send`):

```ts
// (imports trimmed to:)
import { computeWorkflowAnalysis } from "./workflowCore.js";
// ...header + send unchanged...
  try {
    if (!root) { send("failed", { message: "missing root" }); return; }
    const { payload, cached, updatedAt } = await computeWorkflowAnalysis(root, {
      dir, force: fresh,
      progress: {
        onPhase: (phase, extra) => send("phase", { phase, ...(extra ?? {}) }),
        onDelta: (text) => send("delta", { text }),
      },
    });
    send("done", { ...payload, cached, updatedAt });
  } catch (err) {
    send("failed", { message: (err as Error)?.message ?? String(err) });
  } finally {
    res.end();
  }
```

- [ ] **Step 5: Run tests to verify pass**

Run: `pnpm -w build && pnpm vitest run src/__tests__/workflowCore.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/workflowCore.ts src/workflowStream.ts src/__tests__/workflowCore.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "refactor(workflow): extract headless computeWorkflowAnalysis core; stream wraps it"
```

---

## Task 4: Warm registry

Declares the four warmables uniformly. Each `warm()` calls its cache-aware compute and reports whether it recomputed (`warmed`) or found a fresh cache (`hit`).

**Files:**
- Create: `src/warm/registry.ts`
- Modify: `src/scorecardStream.ts` (export the cache-root constant so the warmable reuses it)
- Test: `src/warm/__tests__/registry.test.ts`

**Interfaces:**
- Consumes: `computeInsights` (Task 2), `computeWorkflowAnalysis` (Task 3), `computeGlobalUsage`, `collectScorecard`, cache read/write fns.
- Produces:
  - `type WarmStatusValue = "warmed" | "hit"`
  - `interface Warmable { id: "usage" | "scorecard" | "insights" | "analyze"; cost: "cheap" | "llm"; scope: "global" | "per-root"; warm(root: string | null, opts: { dir?: string; force?: boolean }): Promise<WarmStatusValue> }`
  - `const WARMABLES: Warmable[]`
  - `export const SCORECARD_CACHE_ROOT` (moved to `src/scorecardStream.ts`, imported here)

- [ ] **Step 1: Export the scorecard cache-root constant**

In `src/scorecardStream.ts`, change `const CACHE_ROOT = "__scorecard__";` to:
```ts
export const SCORECARD_CACHE_ROOT = "__scorecard__";
```
and update its single in-file use (the two `deps.readCache(CACHE_ROOT, ...)` / `deps.writeCache(CACHE_ROOT, ...)` calls) to `SCORECARD_CACHE_ROOT`.

Run: `grep -n "CACHE_ROOT" src/scorecardStream.ts` — expect all references now read `SCORECARD_CACHE_ROOT`.

- [ ] **Step 2: Write the failing test**

Create `src/warm/__tests__/registry.test.ts`. Test the `usage` warmable end-to-end against a temp home (cheap, no agent):

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WARMABLES } from "../registry.js";

const orig = process.env.AGENTGEM_HOME;
afterEach(() => { if (orig === undefined) delete process.env.AGENTGEM_HOME; else process.env.AGENTGEM_HOME = orig; });

function usage() { return WARMABLES.find((w) => w.id === "usage")!; }

describe("usage warmable", () => {
  it("warms on first call, then reports a hit on the second (same sessions)", async () => {
    const home = mkdtempSync(join(tmpdir(), "reg-"));
    process.env.AGENTGEM_HOME = home;
    const claudeDir = join(home, ".claude", "projects", "-proj");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "s.jsonl"), JSON.stringify({ cwd: "/proj" }) + "\n");
    const dir = join(home, ".claude");

    expect(await usage().warm(null, { dir })).toBe("warmed");
    expect(await usage().warm(null, { dir })).toBe("hit");
    expect(await usage().warm(null, { dir, force: true })).toBe("warmed");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/warm/__tests__/registry.test.ts`
Expected: FAIL — cannot find module `../registry.js`.

- [ ] **Step 4: Write `src/warm/registry.ts`**

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/warm/registry.ts
//
// The v1 warmable inventory. Each warm() is cache-aware and returns whether it
// recomputed ("warmed") or found a fresh cache entry ("hit"). Global/aggregate
// warmables ignore the root argument; per-root warmables receive a project root.
import { resolveDirs } from "@agentgem/model";
// usage scan + its cache live in @agentgem/capture:
import { computeGlobalUsage, readGlobalUsageCache, writeGlobalUsageCache } from "@agentgem/capture";
// transcript helpers + the analysis cache live in @agentgem/insight:
import { allClaudeTranscripts, transcriptToken, readAnalysisCache, writeAnalysisCache } from "@agentgem/insight";
import { collectScorecard, selectScorecardRoots, scorecardTranscriptPaths, defaultScorecardDeps } from "../gem/scorecard.js";
import { SCORECARD_CACHE_ROOT } from "../scorecardStream.js";
import { computeInsights } from "../insightsCore.js";
import { computeWorkflowAnalysis } from "../workflowCore.js";

export type WarmStatusValue = "warmed" | "hit";
export interface Warmable {
  id: "usage" | "scorecard" | "insights" | "analyze";
  cost: "cheap" | "llm";
  scope: "global" | "per-root";
  warm(root: string | null, opts: { dir?: string; force?: boolean }): Promise<WarmStatusValue>;
}

export const WARMABLES: Warmable[] = [
  {
    id: "usage", cost: "cheap", scope: "global",
    async warm(_root, { dir, force }) {
      const dirs = resolveDirs(dir);
      const paths = allClaudeTranscripts(dirs.claudeDir);
      const token = transcriptToken(paths);
      if (!force && readGlobalUsageCache(token)) return "hit";
      writeGlobalUsageCache(token, computeGlobalUsage(dirs, paths), dirs.claudeDir);
      return "warmed";
    },
  },
  {
    id: "scorecard", cost: "cheap", scope: "global",
    async warm(_root, { dir, force }) {
      const bucket = defaultScorecardDeps.bucketTranscripts(dir);
      const roots = selectScorecardRoots(dir, undefined, defaultScorecardDeps);
      const token = transcriptToken(scorecardTranscriptPaths(roots, bucket));
      if (!force && readAnalysisCache(SCORECARD_CACHE_ROOT, token)) return "hit";
      const sc = collectScorecard(dir, undefined, Date.now(), { bucket });
      if (!sc.degraded) { writeAnalysisCache(SCORECARD_CACHE_ROOT, token, sc, Date.now()); }
      return "warmed";
    },
  },
  {
    id: "insights", cost: "llm", scope: "per-root",
    async warm(root, { dir, force }) {
      const r = await computeInsights(root as string, { dir, force });
      return r.cached ? "hit" : "warmed";
    },
  },
  {
    id: "analyze", cost: "llm", scope: "per-root",
    async warm(root, { dir, force }) {
      const r = await computeWorkflowAnalysis(root as string, { dir, force });
      return r.cached ? "hit" : "warmed";
    },
  },
];
```

Import provenance (already grep-confirmed against the codebase): `computeGlobalUsage`, `readGlobalUsageCache`, `writeGlobalUsageCache` → `@agentgem/capture` (as used in `src/gem.controller.ts`); `allClaudeTranscripts`, `transcriptToken`, `readAnalysisCache`, `writeAnalysisCache` → `@agentgem/insight` (as used in `src/insightsStream.ts` / `src/scorecardStream.ts`).

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm -w build && pnpm vitest run src/warm/__tests__/registry.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/warm/registry.ts src/scorecardStream.ts src/warm/__tests__/registry.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(warm): warmable registry (usage/scorecard/insights/analyze)"
```

---

## Task 5: Orchestrator — `runWarmPass` + foreground gate + status

The engine. Runs global warmables once; runs LLM per-root warmables for the top-N recent projects, serially, skipping when foreground-busy. Best-effort. Exposes status.

**Files:**
- Create: `src/warm/orchestrator.ts`
- Test: `src/warm/__tests__/orchestrator.test.ts`

**Interfaces:**
- Consumes: `Warmable`, `WARMABLES` (Task 4); `readRecents` from `@agentgem/capture`; `agentgemHome` from `@agentgem/model`.
- Produces:
  - `type WarmItemStatus = "warmed" | "hit" | "skipped" | "error"`
  - `interface WarmOutcome { id: string; root: string | null; status: WarmItemStatus }`
  - `interface WarmPassResult { startedAt: number; finishedAt: number; outcomes: WarmOutcome[] }`
  - `interface WarmStatus { running: boolean; last: WarmPassResult | null }`
  - `runWarmPass(opts?: { dir?: string; roots?: string[]; force?: boolean; topN?: number; now?: () => number; registry?: Warmable[]; isBusy?: () => boolean; home?: string }): Promise<WarmPassResult>`
  - `getWarmStatus(): WarmStatus`
  - `beginForeground(): void` / `endForeground(): void` / `isForegroundBusy(): boolean`

- [ ] **Step 1: Write the failing tests**

Create `src/warm/__tests__/orchestrator.test.ts`. Inject a fake registry + roots so no fs/agent runs:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { runWarmPass, getWarmStatus, beginForeground, endForeground } from "../orchestrator.js";
import type { Warmable } from "../registry.js";

function fakeRegistry(calls: string[]): Warmable[] {
  const mk = (id: Warmable["id"], cost: Warmable["cost"], scope: Warmable["scope"]): Warmable => ({
    id, cost, scope,
    async warm(root) { calls.push(`${id}:${root ?? "-"}`); return "warmed"; },
  });
  return [mk("usage", "cheap", "global"), mk("insights", "llm", "per-root")];
}

describe("runWarmPass", () => {
  it("runs global warmables once and per-root LLM warmables for the top-N roots", async () => {
    const calls: string[] = [];
    const res = await runWarmPass({
      registry: fakeRegistry(calls),
      roots: ["/a", "/b", "/c"], topN: 2, now: () => 1000, isBusy: () => false,
    });
    expect(calls).toEqual(["usage:-", "insights:/a", "insights:/b"]);   // /c dropped by topN=2
    expect(res.outcomes.filter((o) => o.status === "warmed")).toHaveLength(3);
  });

  it("skips LLM warmables when foreground is busy, still runs cheap ones", async () => {
    const calls: string[] = [];
    const res = await runWarmPass({
      registry: fakeRegistry(calls), roots: ["/a"], topN: 5, now: () => 1, isBusy: () => true,
    });
    expect(calls).toEqual(["usage:-"]);
    expect(res.outcomes.find((o) => o.id === "insights")?.status).toBe("skipped");
  });

  it("is best-effort: a throwing warmable is recorded as error and does not abort the pass", async () => {
    const calls: string[] = [];
    const reg: Warmable[] = [
      { id: "usage", cost: "cheap", scope: "global", async warm() { throw new Error("boom"); } },
      { id: "insights", cost: "llm", scope: "per-root", async warm(root) { calls.push(String(root)); return "warmed"; } },
    ];
    const res = await runWarmPass({ registry: reg, roots: ["/a"], now: () => 1, isBusy: () => false });
    expect(res.outcomes.find((o) => o.id === "usage")?.status).toBe("error");
    expect(calls).toEqual(["/a"]);   // insights still ran after usage threw
  });

  it("reports running=false and the last result after a pass; foreground flag toggles", async () => {
    beginForeground();
    // isForegroundBusy default is used only when isBusy is not injected; here we assert the toggle:
    endForeground();
    await runWarmPass({ registry: fakeRegistry([]), roots: [], now: () => 42, isBusy: () => false });
    expect(getWarmStatus().running).toBe(false);
    expect(getWarmStatus().last?.finishedAt).toBe(42);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/warm/__tests__/orchestrator.test.ts`
Expected: FAIL — cannot find module `../orchestrator.js`.

- [ ] **Step 3: Write `src/warm/orchestrator.ts`**

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/warm/orchestrator.ts
//
// The single warming engine. Trigger-agnostic: the in-process schedule (now) and
// a future daemon (later) both call runWarmPass. Global warmables run once; LLM
// per-root warmables run for the top-N most-recently-active projects, serially,
// and are skipped while a foreground compute is in flight. Best-effort throughout.
import { agentgemHome } from "@agentgem/model";
import { readRecents } from "@agentgem/capture";
import { WARMABLES, type Warmable } from "./registry.js";

export type WarmItemStatus = "warmed" | "hit" | "skipped" | "error";
export interface WarmOutcome { id: string; root: string | null; status: WarmItemStatus }
export interface WarmPassResult { startedAt: number; finishedAt: number; outcomes: WarmOutcome[] }
export interface WarmStatus { running: boolean; last: WarmPassResult | null }

const DEFAULT_TOP_N = 5;

// Foreground gate: incremented while a user-facing LLM compute (insights/analyze
// SSE endpoint) is in flight, so background warms yield the agent to the user.
let foreground = 0;
export function beginForeground(): void { foreground++; }
export function endForeground(): void { foreground = Math.max(0, foreground - 1); }
export function isForegroundBusy(): boolean { return foreground > 0; }

let status: WarmStatus = { running: false, last: null };
export function getWarmStatus(): WarmStatus { return status; }

export async function runWarmPass(opts: {
  dir?: string; roots?: string[]; force?: boolean; topN?: number;
  now?: () => number; registry?: Warmable[]; isBusy?: () => boolean; home?: string;
} = {}): Promise<WarmPassResult> {
  const now = opts.now ?? Date.now;
  const registry = opts.registry ?? WARMABLES;
  const isBusy = opts.isBusy ?? isForegroundBusy;
  const topN = opts.topN ?? DEFAULT_TOP_N;
  const roots = opts.roots
    ?? readRecents(opts.home ?? agentgemHome()).map((r) => r.path);
  const llmRoots = roots.slice(0, topN);

  status = { running: true, last: status.last };
  const startedAt = now();
  const outcomes: WarmOutcome[] = [];

  for (const w of registry) {
    if (w.scope === "global") {
      outcomes.push(await runOne(w, null, opts));
    } else {
      for (const root of llmRoots) {
        if (w.cost === "llm" && isBusy()) { outcomes.push({ id: w.id, root, status: "skipped" }); continue; }
        outcomes.push(await runOne(w, root, opts));   // serial: await each before the next
      }
    }
  }

  const result: WarmPassResult = { startedAt, finishedAt: now(), outcomes };
  status = { running: false, last: result };
  return result;
}

async function runOne(w: Warmable, root: string | null, opts: { dir?: string; force?: boolean }): Promise<WarmOutcome> {
  try {
    const s = await w.warm(root, { dir: opts.dir, force: opts.force });
    return { id: w.id, root, status: s };
  } catch (err) {
    console.error(`[warm] ${w.id} ${root ?? "(global)"} failed:`, err);
    return { id: w.id, root, status: "error" };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -w build && pnpm vitest run src/warm/__tests__/orchestrator.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/warm/orchestrator.ts src/warm/__tests__/orchestrator.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(warm): runWarmPass orchestrator with top-N + foreground gate + status"
```

---

## Task 6: Schedule — boot pass + idle loop

The Trigger-A glue: one pass shortly after boot, then a low-frequency idle timer. Timer functions are injected so it is unit-testable without real time.

**Files:**
- Create: `src/warm/schedule.ts`
- Test: `src/warm/__tests__/schedule.test.ts`

**Interfaces:**
- Consumes: `runWarmPass` (Task 5).
- Produces:
  - `interface WarmSchedule { stop(): void }`
  - `startWarmSchedule(opts?: { intervalMs?: number; run?: () => Promise<unknown>; setInterval?: (fn: () => void, ms: number) => { unref?: () => void }; clearInterval?: (h: unknown) => void; runNow?: (fn: () => void) => void }): WarmSchedule`

- [ ] **Step 1: Write the failing test**

Create `src/warm/__tests__/schedule.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { startWarmSchedule } from "../schedule.js";

describe("startWarmSchedule", () => {
  it("runs once immediately and again on each interval tick, and stop() clears the timer", () => {
    let runs = 0;
    let tick: (() => void) | null = null;
    let cleared = false;
    const sched = startWarmSchedule({
      intervalMs: 1000,
      run: async () => { runs++; },
      runNow: (fn) => fn(),                       // synchronous "boot" run
      setInterval: (fn) => { tick = fn; return {}; },
      clearInterval: () => { cleared = true; },
    });
    expect(runs).toBe(1);        // boot pass
    tick!(); tick!();            // two idle ticks
    expect(runs).toBe(3);
    sched.stop();
    expect(cleared).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/warm/__tests__/schedule.test.ts`
Expected: FAIL — cannot find module `../schedule.js`.

- [ ] **Step 3: Write `src/warm/schedule.ts`**

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/warm/schedule.ts
//
// Trigger A: fire one warm pass shortly after boot, then re-run on a low-freq
// idle timer. Cheap because unchanged transcript tokens short-circuit inside the
// warmables. Timer + runner are injectable for tests. A future daemon (Trigger C)
// can drive runWarmPass directly and ignore this module.
import { runWarmPass } from "./orchestrator.js";

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;   // 10 minutes

export interface WarmSchedule { stop(): void }

export function startWarmSchedule(opts: {
  intervalMs?: number;
  run?: () => Promise<unknown>;
  setInterval?: (fn: () => void, ms: number) => { unref?: () => void };
  clearInterval?: (h: unknown) => void;
  runNow?: (fn: () => void) => void;
} = {}): WarmSchedule {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const run = opts.run ?? (() => runWarmPass());
  const setI = opts.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms));
  const clearI = opts.clearInterval ?? ((h) => globalThis.clearInterval(h as ReturnType<typeof globalThis.setInterval>));
  // Default boot run is deferred a tick so it never blocks the caller (server boot).
  const runNow = opts.runNow ?? ((fn) => { setTimeout(fn, 0); });

  const fire = () => { void run(); };
  runNow(fire);
  const handle = setI(fire, intervalMs);
  handle?.unref?.();   // don't keep the process alive just for warming

  return { stop() { clearI(handle); } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/warm/__tests__/schedule.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/warm/schedule.ts src/warm/__tests__/schedule.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(warm): boot + idle warm schedule (Trigger A)"
```

---

## Task 7: Wire into the server — status endpoint, foreground gate, schedule start

**Files:**
- Modify: `src/index.ts` (add `/api/warm/status`; wrap the two LLM SSE routes with the foreground gate; start the schedule in `run()` behind the console gate)
- Test: `src/__tests__/warmStatus.route.test.ts`

**Interfaces:**
- Consumes: `getWarmStatus`, `beginForeground`, `endForeground` (Task 5); `startWarmSchedule` (Task 6).
- Produces: `GET /api/warm/status` → `{ running: boolean; last: WarmPassResult | null }`.

- [ ] **Step 1: Write the failing test** (pure handler shape — no server spin-up)

Create `src/__tests__/warmStatus.route.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { getWarmStatus } from "../warm/orchestrator.js";

describe("warm status shape", () => {
  it("exposes running + last fields consumed by the /api/warm/status route", () => {
    const s = getWarmStatus();
    expect(s).toHaveProperty("running");
    expect(s).toHaveProperty("last");
    expect(typeof s.running).toBe("boolean");
  });
});
```

- [ ] **Step 2: Run test to verify it passes trivially (guards the contract)**

Run: `pnpm -w build && pnpm vitest run src/__tests__/warmStatus.route.test.ts`
Expected: PASS. (This locks the status contract the route depends on; the wiring below has no separate unit seam beyond the orchestrator/schedule tests.)

- [ ] **Step 3: Add imports to `src/index.ts`**

Near the other `./warm`-free imports (top of file), add:
```ts
import { getWarmStatus, beginForeground, endForeground } from "./warm/orchestrator.js";
import { startWarmSchedule } from "./warm/schedule.js";
```

- [ ] **Step 4: Register the status route and wrap the LLM SSE routes**

In `createApp`, where the raw routes are registered (currently lines ~169–178), replace the insights and workflow-analyze registrations with foreground-wrapped versions and add the status route:

```ts
server.expressApp.get("/api/warm/status", originGuard, (_req, res) => res.json(getWarmStatus()));

// Foreground gate: mark user-facing LLM computes so background warming yields.
server.expressApp.get("/api/workflow/analyze/stream", originGuard, async (req, res) => {
  beginForeground();
  try { await streamWorkflowAnalyze(req as never, res as never); } finally { endForeground(); }
});
server.expressApp.get("/api/insights/stream", originGuard, async (req, res) => {
  beginForeground();
  try { await streamInsights(req as never, res as never); } finally { endForeground(); }
});
```

(Leave the `/api/gem/run/stream` and `/api/scorecard/stream` registrations unchanged — scorecard is cheap and not gated.)

- [ ] **Step 5: Start the schedule in `run()` behind the console gate**

In `run()` (after `installGracefulShutdown(app);`, before the `console.log`s), add:

```ts
// Background cache warming — console (local desktop) only; never on the hosted API.
if (process.env.SERVE_CONSOLE !== "false") startWarmSchedule();
```

- [ ] **Step 6: Typecheck + full backend suite**

Run: `pnpm -w build && pnpm test`
Expected: PASS (no regressions; new files compile).

- [ ] **Step 7: Commit**

```bash
git add src/index.ts src/__tests__/warmStatus.route.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(warm): /api/warm/status, foreground gate on LLM streams, start schedule on boot"
```

---

## Task 8: UI — freshness timestamp + warming pill

Surfaces "updated Xm ago" next to the existing Re-run/Re-scan controls (Insights + Mine), and a global "warming…" pill that polls `/api/warm/status`. Force-redo already works via the existing buttons.

**Files:**
- Create: `packages/console/src/util/timeAgo.ts`
- Test: `packages/console/src/util/timeAgo.test.ts`
- Create: `packages/console/src/components/WarmingPill.tsx`
- Modify: `packages/console/src/panels/Insights/insightsStream.ts` (thread `updatedAt` from the `done` event)
- Modify: `packages/console/src/panels/Insights/index.tsx` (render `updated Xm ago`)
- Modify: `packages/console/src/panels/Mine/scorecardStream.ts` + `Mine/Scorecard.tsx` (render `updated Xm ago`)
- Modify: the app shell that renders the panels (mount `<WarmingPill />` — locate with grep in Step 6)

**Interfaces:**
- Consumes: `GET /api/warm/status`.
- Produces:
  - `timeAgo(fromMs: number, nowMs?: number): string` — e.g. `"just now"`, `"3m ago"`, `"2h ago"`.
  - `<WarmingPill apiBase={string} />` React component.

- [ ] **Step 1: Write the failing test for `timeAgo`**

Create `packages/console/src/util/timeAgo.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { timeAgo } from "./timeAgo.js";

describe("timeAgo", () => {
  const now = 1_000_000_000_000;
  it("formats recent, minutes, and hours", () => {
    expect(timeAgo(now - 5_000, now)).toBe("just now");
    expect(timeAgo(now - 3 * 60_000, now)).toBe("3m ago");
    expect(timeAgo(now - 2 * 3_600_000, now)).toBe("2h ago");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/console && pnpm vitest run src/util/timeAgo.test.ts`
Expected: FAIL — cannot find module `./timeAgo.js`.

- [ ] **Step 3: Write `packages/console/src/util/timeAgo.ts`**

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
export function timeAgo(fromMs: number, nowMs: number = Date.now()): string {
  const s = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  if (s < 30) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/console && pnpm vitest run src/util/timeAgo.test.ts`
Expected: PASS.

- [ ] **Step 5: Thread `updatedAt` through the Insights + Mine stream clients and render it**

In `packages/console/src/panels/Insights/insightsStream.ts`, extend the `done` event type and mapping to carry `updatedAt` (the server now sends it):
```ts
// in the done union member:
| { type: "done"; cached: boolean; updatedAt: number | null; /* ...existing fields... */ }
// in the "done" handler:
onEvent({ type: "done", cached: !!d.cached, updatedAt: typeof d.updatedAt === "number" ? d.updatedAt : null, /* ...existing... */ });
```
In `packages/console/src/panels/Insights/index.tsx`, next to the existing `Re-run ↻` button (line ~101), render the timestamp when present. Store `updatedAt` from the `done` event in the panel's report state, then:
```tsx
{report?.updatedAt != null && (
  <span className="ledger-muted" style={{ marginLeft: "auto", marginRight: 8 }}>
    updated {timeAgo(report.updatedAt)}
  </span>
)}
```
(Add `import { timeAgo } from "../../util/timeAgo.js";`. Move the existing `marginLeft: "auto"` off the button since the timestamp now takes that slot, so the two sit together on the right.)

Repeat the same two changes for Mine: extend the `done` mapping in `packages/console/src/panels/Mine/scorecardStream.ts` with `updatedAt`, and render `updated {timeAgo(...)}` beside the `RefreshButton` in `Mine/Scorecard.tsx`.

**Note:** the scorecard `done` payload does not yet include `updatedAt`. Add it in `src/scorecardStream.ts`'s final `send("done", ...)` by reading the cache entry timestamp: change the cached branch to use `readAnalysisCacheEntry(SCORECARD_CACHE_ROOT, token)` (send `updatedAt: entry.ts, cached: true`) and the fresh branch to send `updatedAt: Date.now()`. Wire `readAnalysisCacheEntry` into `realStreamDeps` alongside `readCache`. (This mirrors Task 2/3's pattern for the aggregate scorecard.)

- [ ] **Step 6: Write the warming pill and mount it**

Create `packages/console/src/components/WarmingPill.tsx`:

```tsx
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";

interface WarmStatus { running: boolean; last: { finishedAt: number } | null }

export function WarmingPill({ apiBase }: { apiBase: string }): JSX.Element | null {
  const [running, setRunning] = useState(false);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch(`${apiBase}/api/warm/status`);
        if (!r.ok) return;
        const s = (await r.json()) as WarmStatus;
        if (alive) setRunning(s.running);
      } catch { /* best-effort */ }
    };
    void poll();
    const h = setInterval(poll, 5000);
    return () => { alive = false; clearInterval(h); };
  }, [apiBase]);
  if (!running) return null;
  return <span className="warming-pill" title="Precomputing insights in the background">warming…</span>;
}
```

Find where the panel chrome/header renders (grep for an existing header pill or the active-Gem switcher) and mount `<WarmingPill apiBase={apiBase} />` there:
Run: `grep -rn "apiBase" packages/console/src/App.tsx packages/console/src/*.tsx | head`
Mount the pill in the app header, passing the same `apiBase` the panels use.

- [ ] **Step 7: Run the console test + typecheck**

Run: `cd packages/console && pnpm vitest run && pnpm exec tsc --noEmit`
Expected: PASS. (Per the "CI skips console tests" note, run these locally — they are not in CI.)

- [ ] **Step 8: Commit**

```bash
git add packages/console/src/util/timeAgo.ts packages/console/src/util/timeAgo.test.ts packages/console/src/components/WarmingPill.tsx packages/console/src/panels/Insights packages/console/src/panels/Mine src/scorecardStream.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(console): freshness timestamps + background warming pill"
```

---

## Final verification

- [ ] **Full backend suite:** `pnpm -w build && pnpm test` → all green.
- [ ] **Console suite (not in CI):** `cd packages/console && pnpm vitest run && pnpm exec tsc --noEmit` → all green.
- [ ] **Manual smoke:** start the console (`SERVE_CONSOLE` unset), confirm the log shows boot, open Insights/Mine and confirm the `updated Xm ago` badge appears; touch a transcript and confirm Re-run recomputes; watch `curl localhost:4317/api/warm/status` flip `running` true→false shortly after boot.
- [ ] **Confirm branch is ahead of `origin/main` only** (per CLAUDE.md), then integrate via the local ff-merge path or open a PR.

## Self-review notes (already reconciled)

- **Spec coverage:** trigger-agnostic engine (Task 5) ✓; warm-on-open + idle (Task 6/7) ✓; tiered cost cheap=all / LLM=top-N=5 (Tasks 4/5) ✓; headless cores extracted (Tasks 2/3) ✓; force-redo (pre-existing buttons + `force` threaded through cores) ✓; inline freshness + pill (Task 8) ✓; `/api/warm/status` (Task 7) ✓; best-effort/never-throw + console-only + don't-cache-degraded (Global Constraints, enforced per task) ✓.
- **Scope correction vs. spec:** the spec said "usage / analysis (+scorecard) / insights"; the code shows `analysisCache` backs *two distinct* computations — the aggregate **scorecard** (cheap, sync) and the per-project **workflow analysis** (LLM). v1 therefore warms four warmables: usage + scorecard (cheap/global) and insights + analyze (LLM/per-root). Observe stays excluded; distill stays the deferred fast-follow.
- **Type consistency:** `WarmStatusValue`("warmed"|"hit") is the warmable return; `WarmItemStatus` adds "skipped"|"error" at the orchestrator; `WarmPassResult`/`WarmStatus` are used identically by Task 5, 6, 7. `updatedAt: number | null` is consistent across cores, `done` payloads, and the UI.
- **Import provenance resolved:** `computeGlobalUsage`/`readGlobalUsageCache`/`writeGlobalUsageCache` from `@agentgem/capture`; `allClaudeTranscripts`/`transcriptToken`/`readAnalysisCache`/`writeAnalysisCache` from `@agentgem/insight` — confirmed against `gem.controller.ts`/`insightsStream.ts`/`scorecardStream.ts` usage.
