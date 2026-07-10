# Cold transcript-index build: parse off the event loop

**Date:** 2026-07-10
**Status:** Approved design, ready for planning
**Branch:** `perf/cold-build-worker`
**Issue:** #284

## Problem

The transcript index (schema v2, PR #301) is inventory-independent, so installing a skill no
longer reparses anything. But the **first** build still parses the whole corpus in one
synchronous pass inside `doSync` (`packages/capture/src/transcriptIndex.ts`): `parseFile(path)`
(read + JSON-parse every transcript) is interleaved with cheap SQLite writes inside one
`BEGIN`/`COMMIT`. Measured on a 3,739-transcript / 3.1 GB home: **~16 s, synchronous, on the
event loop**. Every HTTP request queues behind it — the same event-loop starvation that made a
463-byte `GET /api/rubrics` take 28,963 ms before #265/#267.

This is the residual blocker those two PRs and #301 left open. It fires on a cold index, or
after any `schema_version` bump (the v1→v2 migration in #301 triggers exactly one).

## Why it can't naively go in a worker

`sharedIndex()` (`packages/capture/src/globalUsage.ts:47-60`) is a **process-wide** `node:sqlite`
`DatabaseSync` handle shared with the `/api/usage` endpoint. A second handle in a worker would
race its `BEGIN`/`COMMIT`. This is the same constraint that kept the `usage` warmable on the main
thread in #267 while `scorecard` could move.

## The shape

Parsing is the expensive part (readFileSync + JSON.parse of 3.1 GB). SQLite writes are cheap
(~800 rows across the corpus). So:

- a **worker** does all filesystem work — stat, read, parse — off the event loop, and posts
  back compact `FileUsage` rows;
- the **main thread**, which owns the sole `DatabaseSync` handle, does all upserts, in yielded
  batches.

This sidesteps the shared-handle race entirely: the worker never opens the DB.

```
ROOT package (src/, bundled by bundle-bins)      │  @agentgem/capture (inlined into the bundle)
─────────────────────────────────────────────────┼──────────────────────────────────────────────
gem.controller.ts / warm/registry.ts             │
  builds offThreadParse (worker-backed)  ─────────┼──▶ getGlobalUsageIndexed(dirs, paths, offThreadParse?)
       │                                           │      └─ index.syncUsage(...) inline  (small / no injector)
  src/transcriptParseWorker.ts  (worker_threads)  │         OR
    stat+read+parse off-thread, posts batches ────┼─────────  streams offThreadParse batches → DB writer
                                                   │            (all upserts here — capture owns the handle)
```

capture never references the worker file or the bundler. It exposes an **injected async
producer** seam and owns every SQLite write; the root provides a worker-backed producer.

```
getGlobalUsageIndexed(dirs, paths, offThreadParse?)          // offThreadParse optional; default → today's inline
  └─ index.syncUsage(paths, hookDigest, parseFile)  when offThreadParse absent
                                                     OR the change-set is ≤ THRESHOLD
  └─ index.syncUsageStreamed(paths, hooks, hookDigest, offThreadParse)  otherwise:
       │  hook_digest guard + load `existing` (as today)
       │  offThreadParse({ paths, existing, hooks, hookDigest, batchSize }, onBatch)
       │     └─ (root impl) spawns transcriptParseWorker; worker stats+reads+parses off-thread,
       │        postMessage → { results:[{path,mtime,size,raw,hooks,failed}] } per batch
       │  per batch (onBatch):  BEGIN/COMMIT the batch's upserts → await setImmediate
       │  on completion:        prune (existing − seen); read back; resolveUsage
```

**Why the injected seam, not capture spawning the worker directly:** `bundle-bins.mjs` bundles
only the **root** package's `dist/` tree; `@agentgem/capture` is workspace-**inlined** into
`dist/index.js`. A worker file inside `packages/capture/` would never be bundled and would ship
with unresolvable `@agentgem/*` imports. And a `resolveWorkerPath` probe from inside capture can't
span the two packages' differing dev-vs-bundled layouts. Keeping the worker in root `src/` (where
`scorecardWorker` already lives and bundles cleanly) and injecting the producer into capture
sidesteps both — and makes the DB-write streaming testable with a fake producer, no worker.

## Design decisions

1. **Single worker, not a pool.** The acceptance is "main stays responsive," which a single
   worker fully meets. A pool would cut the ~16 s wall-clock but multiplies the peak-RSS spike
   the warm pass already warns about, for a one-time background build. (Rejected — see Non-goals.)
2. **Threshold on change-set size.** A warm sync (0–few changed files) parses **inline**,
   exactly as today, so the 0.03 s warm path this project just won is untouched. Only a
   large change-set (cold build, or a big batch) goes to the worker. `THRESHOLD` is a named
   constant; a mid-size sync near the boundary picks either path (both correct).
3. **Streaming batched writes, not one final transaction.** The worker posts results in batches;
   the main thread writes each batch in its own `BEGIN`/`COMMIT` and `setImmediate`-yields
   between. This keeps every write stall tiny (one batch, not ~50–200 ms for the whole corpus),
   so the < 100 ms bar holds by construction. Per-file consistency is preserved
   (`transcript_file` is upserted only alongside its own rows), so an interrupted build just
   resumes on the next sync — atomicity of the *whole* sync is not needed for a rebuildable cache.
4. **`syncUsage` unchanged; a sibling streamed path.** `syncUsage(paths, hookDigest, parseFile)`
   keeps its exact contract (inline, injected parser) — its 10 unit tests stay green, an injected
   fake parser is never silently bypassed. `syncUsageStreamed` is the separate worker-consuming
   unit, sharing the extracted `writeFileRows` helper (DRY).
5. **The worker lives in the root package and is injected into capture, not spawned by it.**
   `bundle-bins` bundles only the root `dist/`; `@agentgem/capture` is workspace-inlined, so a
   worker inside capture would never be bundled. capture exposes the `offThreadParse` producer
   seam and owns all DB writes; the root implements the seam with a `worker_threads` worker it can
   bundle. Bonus: the DB-write streaming is unit-testable with a fake producer, no worker spawned.

## Components

**Root package** (`src/` — bundled by `bundle-bins`):

| File | Responsibility |
|---|---|
| `src/transcriptParseWorker.ts` *(create)* | Worker entry, mirrors `src/warm/scorecardWorker.ts`. Exports the pure body (`parseChangedFiles(input, emit)` — stat + `scanFileUsage` from `@agentgem/insight`, emit batches) for reuse/tests; a `parentPort` guard runs it and `postMessage`s each batch. No SQLite, no DB import. |
| `src/coldBuildParser.ts` *(create)* | Builds the injected `offThreadParse` producer: `resolveWorkerPath(import.meta.url)` (reusing `src/warm/workerPath.ts`), `new Worker(...)`, wires `message` → `onBatch`, resolves on `done`, rejects on `error`/nonzero-exit. This is the only place `worker_threads` and the worker path live. |
| `src/warm/workerPath.ts` *(reuse, no edit)* | `resolveWorkerPath(baseUrl, candidates)` already takes `candidates` as a parameter. `coldBuildParser.ts` calls it with this worker's two-layout candidates (`["./transcriptParseWorker.js", "./warm/transcriptParseWorker.js"]` — loose tsc output vs bundled). No change to `workerPath.ts` itself. |
| `src/gem.controller.ts` (`usage()`) + `src/warm/registry.ts` (`usage` warmable) *(modify)* | Pass `buildOffThreadParse()` as the new `offThreadParse` arg to `getGlobalUsageIndexed`. |
| `scripts/bundle-bins.mjs` *(modify)* | Add `"transcriptParseWorker.js"` to `entries` so it ships self-contained (0 bare `@agentgem/*` imports), exactly as `warm/scorecardWorker.js` does. |
| `src/gem/__tests__/coldBuildWorker.test.ts` *(create)* | Heartbeat acceptance gate + worker-vs-inline differential (real worker, opt-in for the real corpus). |

**`@agentgem/capture`** (inlined into the bundle — zero worker/bundler knowledge):

| File | Responsibility |
|---|---|
| `packages/capture/src/transcriptIndex.ts` *(modify)* | Extract the per-file upsert into a private `writeFileRows(db, path, mtime, size, hookDigest, usage)` helper. Add `syncUsageStreamed(paths, hooks, hookDigest, offThreadParse)`: hook_digest guard + load `existing`, drive `offThreadParse` (producer), write each batch in its own `BEGIN`/`COMMIT` via the helper, `setImmediate`-yield, prune, return stored rows. `syncUsage` body UNCHANGED. |
| `packages/capture/src/globalUsage.ts` *(modify)* | `getGlobalUsageIndexed(dirs, paths, offThreadParse?)`. Compute the change-set cheaply (or let `syncUsageStreamed` decide); if `offThreadParse` present AND change-set > THRESHOLD → `syncUsageStreamed`, else the existing `syncUsage` inline path. Default (no arg) = today's behavior exactly. |
| `src/gem/__tests__/transcriptIndexStreamed.test.ts` *(create)* | Unit-test `syncUsageStreamed` with a FAKE `offThreadParse` yielding canned batches (no worker): asserts byte-identical rows to `syncUsage`, per-batch transactions, `failed` handling, prune. |

The `OffThreadParse` type (shared contract) lives in capture (where `syncUsageStreamed` consumes
it); the root's `coldBuildParser` implements it.

## The worker-vs-inline decision (cheap, no stat storm)

Computing the true change-set requires statting every path — itself ~100 ms of main-thread work
on a cold corpus, defeating the point. Instead route on a **cheap proxy**: the count of files the
index has never seen. Add `fileCount(): number` to the `TranscriptIndex` interface (a
`SELECT COUNT(*) FROM transcript_file`, instant). Then:

```
if (offThreadParse && (paths.length - index.fileCount()) > THRESHOLD)  → syncUsageStreamed (worker)
else                                                                    → syncUsage (inline, as today)
```

A **cold index** (`fileCount()===0`) and a **schema-bump-wiped index** both route to the worker —
those are the only cases that take ~16 s. A **warm index** (`fileCount() ≈ paths.length`) routes
inline and stays instant. The rare "warm index, but a bulk edit changed many existing files" case
routes inline (slow once, correct, self-healing next sync) — it's outside the acceptance criteria,
which is specifically about the cold build. Document this as the deliberate proxy it is.

## Worker contract

`offThreadParse(input, onBatch): Promise<{ seen: string[] }>` — the capture-side seam. The root's
implementation (`coldBuildParser.ts`) spawns the worker; a fake implementation drives the unit test.

**Worker `workerData`** (structured-cloneable plain objects):
```
{ paths: string[],
  existing: Record<string, { mtime: number; size: number; hookDigest: string }>,
  hooks: HookArtifact[],          // scanFileUsage needs the hook inventory
  hookDigest: string,
  batchSize: number }
```
**Worker work:** for each `path`, `statSync`. Stat-fails → vanished (NOT added to `seen`).
Unchanged (`mtime`+`size`+`hookDigest` all match `existing[path]`) → add to `seen`, skip. Changed
→ `scanFileUsage(path, hooks)`, add to `seen`, buffer `{path, mtime, size, raw, hooks, failed}`.
**Worker out:** `postMessage({ results })` every `batchSize` buffered files; a final
`postMessage({ seen, done: true })`. `coldBuildParser` relays each `results` to `onBatch` and
resolves with `{ seen }` on `done`.

**capture (`syncUsageStreamed`), per `onBatch`:** `BEGIN`; for each result, the private
`writeFileRows` helper (delete raw/hook rows for path, insert new, upsert `transcript_file` with
`hook_digest`); `COMMIT`; `await setImmediate`. A `failed:true` result skips its upsert (keeps
prior rows, same as A3). On completion → prune `existing.keys() − seen` (own transaction) → read
back joined rows → return. `getGlobalUsageIndexed` then calls `resolveUsage`.

## Error handling

- **Worker unresolvable / spawn error / mid-run throw** → the whole sync falls back to the inline
  `syncUsage(paths, hookDigest, parseFile)` (blocking, but correct). Logged via `createLogger`.
  Idempotent `ON CONFLICT` upserts mean a partial worker write followed by an inline re-sync
  cannot double-count.
- **A single file read-fails in the worker** → `failed:true` in its result → main skips its
  upsert, leaves prior rows (identical to today's A3 typed-failure path).
- **Worker exits non-zero without `done`** → treated as a mid-run failure → inline fallback.

## Testing

- **`syncUsageStreamed` unit (capture, no worker):** drive it with a FAKE `offThreadParse` that
  yields canned batches. Assert (a) the stored rows are byte-identical to running the same fixture
  through `syncUsage`; (b) each batch was a separate transaction (observe via a batch of 2 files →
  2 `onBatch` calls → rows present after each); (c) a `failed:true` result skips its upsert and
  keeps prior rows; (d) prune removes `existing − seen`. This covers the DB-write logic with zero
  worker flakiness.
- **Decision routing:** `paths.length - fileCount() > THRESHOLD` with `offThreadParse` present →
  `syncUsageStreamed` (spy); at/below, or no `offThreadParse` → `syncUsage` inline. Cold index
  (`fileCount()===0`) routes to the streamed path.
- **Fallback:** `coldBuildParser` with an unresolvable worker path (or a worker that errors) →
  `getGlobalUsageIndexed` falls back to inline `syncUsage` and yields identical rows.
- **Acceptance gate (root, the point of the change):** build a cold index over a fixture corpus
  large enough to take real wall-time via the REAL worker; run a 50 ms `setInterval` heartbeat on
  the main thread during the build; assert max contiguous loop-block < 100 ms. Self-test the
  heartbeat against a known busy-wait first (#267 gotcha: `await` a macrotask before
  `clearInterval` or the recording tick never fires). Opt-in `AGENTGEM_COLD_BUILD_REAL` variant
  over the real `~/.claude/projects`.
- **Worker-vs-inline differential (root, real worker):** the same corpus built via the worker
  path and via inline `syncUsage` yields byte-identical `/api/usage` output.
- **Packaging:** assert `transcriptParseWorker.js` is in `bundle-bins.mjs` `entries`; verify
  against a real `node scripts/bundle-bins.mjs` that the bundled worker has 0 bare `@agentgem/*`
  imports and its `resolveWorkerPath` candidates find it in the bundled layout. This trap only
  reproduces from a packed install, never from source (#267).

## Verification

Measured, not asserted:

| | before | expected after |
|---|---|---|
| 463-byte `GET` during a cold build | up to ~16 s (blocked) | < 100 ms |
| cold build wall-clock | ~16 s (blocking) | ~16 s (off-thread) |
| warm, unchanged `/api/usage` | 0.11 s | 0.11 s (inline path, unchanged) |
| `/api/usage` output, worker vs inline | — | byte-identical |

## Non-goals

- **A worker pool / faster cold build.** Single worker; the goal is non-blocking, not faster.
- **Changing the warm path.** ≤ THRESHOLD stays inline and instant.
- **Whole-sync atomicity.** The index is a per-file-consistent cache; batched transactions are
  correct and an interrupted build resumes.
- **Moving `scanFileUsage`, `resolveUsage`, or the schema.** Those are #301; this only changes
  *where* parsing runs.
