# Background Warming for the Precompute Layer

**Date:** 2026-07-01
**Status:** Design approved, ready for implementation plan
**Branch:** `feat/warm-precompute`

## Problem

AgentGem already turns local agent setup, session transcripts, and usage data
into human-readable insights, scorecards, and gems. But every expensive
computation is **lazy**: it runs only when you open the panel. Opening the
Insights panel for a project whose sessions have changed still costs a 15–20s
recompute (two agent passes). There is no proactive precompute, no unified
orchestration across projects, and no explicit "recompute now" control.

The goal: **save results so we stop recomputing on demand, warm them ahead of
the user, and offer a force-redo escape hatch** — for the private, single-user
case first, designed so an always-on daemon can drive the same engine later.

## What already exists (do not rebuild)

Three persistent caches under `~/.agentgem/`, all sharing one shape:

| Cache | File | Backs |
|---|---|---|
| usage | `global-usage-cache.json` | global usage scan (cheap, file reads) |
| analysis | `analysis-cache.json` | workflow analysis + **scorecard** (LLM) |
| insights | `insights-cache.json` | insights report, two passes (LLM) |

Shared contract:
- Keyed by `(projectRoot, token)` where `token = version:sessionCount:newestMtime`.
  A new/changed session bumps `newestMtime` → new token → automatic invalidation.
- `TOKEN_VERSION` prefix lets the payload shape version independently.
- Best-effort: reads/writes never throw. Capped at 50 entries (LRU by `ts`).
- `usageCache` additionally exposes `readGlobalUsageCacheStale()` —
  stale-while-revalidate (return old data regardless of token).
- Degraded/fallback LLM payloads are **not** cached
  (`if (!payload.degraded) writeInsightsCache(...)`).

So content-driven invalidation already works. The token cannot see *config*
drift (a changed analysis prompt or model), which is what force-redo covers.

## What's missing (this project)

1. **No proactive warming** — caches fill only when a panel is opened.
2. **No unified orchestrator** — three caches, each filled by its own panel.
3. **No headless compute path** — the compute lives inside SSE stream functions
   (`streamInsights(req, res)`, `streamScorecard(req, res)`) that own transport
   *and* computation + caching. A warmer cannot `await` them for a value.
4. **No explicit force-redo** — no way to recompute when the token can't see the
   reason (prompt/model changed).

## Decisions (locked)

| Fork | Decision |
|---|---|
| First user | **Private / for-yourself.** Payoff = instant panels, no manual scans. |
| Trigger | **A (warm-on-open + idle loop), now; C (daemon) later** — same engine, swappable trigger. |
| Warming aggressiveness | **Tiered.** Cheap → all projects. LLM → top-N most-recently-active (N=5). |
| Force-redo UX | **Inline per-panel** badge `Cached · updated 3m ago · [Refresh]`; Refresh = force. Global `warming…` pill. |
| Scope | v1 = the three existing caches only. **Observe excluded** (cheap + already memoized). **Distill = fast-follow.** |

## Architecture

```
                    ┌─────────────────────────────┐
  Trigger A (now)   │   runWarmPass(opts)          │   Trigger C (later)
  server boot ─────▶│   the orchestrator core      │◀───── fs watcher on
  idle timer  ─────▶│  (pure, HTTP-less, best-     │       ~/.claude/projects
                    │   effort, abortable)         │
                    └─────────────┬───────────────┘
                                  │ iterates warmable registry × projects
                                  ▼
              ┌───────────────────────────────────────┐
              │  compute cores (extracted from streams)│
              │  computeUsage / computeAnalysis /       │
              │  computeInsights — cache-aware,          │
              │  return a value, no req/res              │
              └───────────────┬───────────────────────┘
                              │ read/write
                              ▼
                   ~/.agentgem/*.json  (existing caches)
                              ▲
   SSE endpoints ────────────┘  (now thin transport wrappers over the cores)
   + Refresh button (force=true) bypasses cache read
```

`runWarmPass()` is the **only** engine. Trigger A drives it from the running
server; Trigger C later drives the *same* function from a watcher — no
re-architecture.

## Components & interfaces

### Compute cores (refactor — targeted, serves this goal)

Extract a headless, cache-aware core from each stream function. The cache
read/write moves *into* the core so the warmer and the SSE endpoint cache
identically.

```ts
// e.g. for insights
export async function computeInsights(
  root: string,
  opts: { force?: boolean; signal?: AbortSignal } = {},
): Promise<InsightsPayload> {
  const paths = /* transcript paths for root */;
  const token = insightsToken(paths);
  if (!opts.force) {
    const cached = readInsightsCache(root, token);
    if (cached) return cached as InsightsPayload;
  }
  const payload = /* the existing two-pass computation */;
  if (!payload.degraded) writeInsightsCache(root, token, payload, Date.now());
  return payload;
}
```

`streamInsights` becomes a thin wrapper: `const r = await computeInsights(root,
{force}); streamResult(res, r)`. Same for analysis/scorecard. `scorecardStream`
already injects `{readCache, writeCache}`, so it's the template for the pattern.

### `src/warm/registry.ts`

```ts
interface Warmable {
  id: "usage" | "analysis" | "insights";
  cost: "cheap" | "llm";
  warm(root: string, opts: { force?: boolean; signal?: AbortSignal }): Promise<void>;
}
```

Each `warm` just calls its compute core and discards the return value (the point
is the cache side effect).

### `src/warm/orchestrator.ts`

```ts
runWarmPass(opts: {
  roots?: string[];       // default: from readRecents()
  force?: boolean;
  topN?: number;          // default 5
  signal?: AbortSignal;
  now?: () => number;     // injected clock for tests
}): Promise<WarmPassResult>
```

- Cheap warmables → run for **all** roots.
- LLM warmables → run for the **top-N** most-recently-active roots (from
  `readRecents()` ordering).
- LLM warms run **serially** (one at a time) and **skip/abort when a foreground
  compute is in flight** (a shared in-process "foreground busy" signal).
- Each warm wrapped best-effort: one failure logs and the pass continues.
- Returns a small result summary (counts per warmable, skipped-hits, errors) for
  the status endpoint.

### `src/warm/schedule.ts` (Trigger A glue)

- On server boot: fire one pass fire-and-forget (never blocks boot).
- Idle timer (default 10 min while app open): re-run a pass — cheap because
  unchanged tokens short-circuit inside the cores.
- Abort in flight on shutdown.

### UI

- Shared `<Freshness>` badge in the three panels: `Cached · updated 3m ago ·
  [Refresh]`. **Refresh** re-requests with `?force=1`.
- Global `warming…` pill reads `GET /api/warm/status` (current pass state from
  the orchestrator's last `WarmPassResult` + in-flight flag).

## Data flow

- **Warm pass:** for each root × warmable → compute `token` → cache hit and not
  `force` ⇒ skip (makes idle re-runs nearly free); else `compute → write`.
- **Panel open:** reads cache by exact token → hit (warmed) ⇒ instant; miss ⇒
  computes inline as today (safety net) and caches.
- **Force-redo:** Refresh → endpoint `force=1` → core bypasses the cache *read*,
  recomputes, overwrites. Covers config drift the mtime token can't see.

## Cost governance

- Cheap (usage) → all projects; LLM (analysis, insights) → top-N (N=5, single
  tunable knob; raise for C's always-on mode).
- LLM warms serial, at most one at a time, yield to foreground.
- Degraded LLM results not cached (preserves existing rule).
- Best-effort throughout; never blocks boot; abortable on shutdown.

## Error handling & testing

Ethos matches the existing caches: best-effort, never throws, never blocks boot.
Abort signal cancels a pass cleanly.

Tests (deps + clock injected, following `scorecardStream`'s `{readCache,
writeCache}` pattern; no `Date.now()` in test bodies):

1. Orchestrator selects the right project set per cost class (cheap=all,
   llm=top-N by recency).
2. Token hit ⇒ **no recompute**; `force` ⇒ recompute + overwrite.
3. One warmable throwing does not abort the pass; other warmables still run.
4. Core-extraction parity: SSE endpoint and warmer write **identical** cache
   entries for the same `(root, token)`.
5. Foreground-busy signal ⇒ LLM warms are skipped/deferred.

## Scope boundaries (YAGNI)

**In v1:** the three existing caches (usage / analysis+scorecard / insights),
the orchestrator, Trigger A, inline Freshness UI + force-redo, `/api/warm/status`.

**Deferred:**
- **Distill caching** — LLM-backed and worth warming, but its shape is an
  MCP-tool/publish dispatch path (`dispatchTool`, salt, inventory), not the
  `stream(req,res)` + `(root, token)` shape. Needs its own cache + headless core
  first — a *second, heterogeneous* pattern. Slots in as one more `Warmable`
  once that exists. Single named fast-follow.
- **Trigger C** — standalone fs-watcher daemon driving the same `runWarmPass()`.
- **Freshness dashboard** — per-project × computation status surface (UX option
  B) — a natural fit once C adds more background activity worth inspecting.

**Explicitly out:** Observe scan warming. `observeScan.ts` is pure file-read and
already memoized in-process (`scanSessionsCached` + `refresh` flag); warming buys
~zero latency.

## Rationale notes

- The three v1 caches are **homogeneous** — one core-extraction pattern applied
  thrice, high test reuse, low risk. Distill would mix a second pattern into the
  same change.
- Extending `readGlobalUsageCacheStale`'s stale-while-revalidate to the other two
  caches is a possible enhancement but not required for v1: warm-on-open already
  fills caches before the user looks. Kept out of v1 scope to stay tight.
