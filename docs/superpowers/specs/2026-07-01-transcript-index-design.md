# Transcript index: a persistent, incremental store for session analysis & search

Date: 2026-07-01
Status: Approved (design) — Phase 1 implemented in this change
Builds on: `2026-06-27-import-usage-perf-design.md` (stale-while-revalidate for `scope=global`)

## Problem

Every transcript-derived view re-reads **all** Claude/Codex `*.jsonl` transcripts on demand and
recounts from scratch. The `scope=global` usage scan is the documented worst case: **~2,999
transcripts → ~4s cold** (`2026-06-27-import-usage-perf-design.md`), and the token-keyed JSON caches
(`analysis-cache.json`, `global-usage-cache.json`, `insights-cache.json`) miss constantly because the
cache token is `version : count : newest-mtime` — **every new Claude session moves the token**, so an
active user pays the full scan on most opens. Stale-while-revalidate hid the latency; it did not
remove the work.

The deeper limitation: there is **no persistent, queryable store** of transcript signal. PGlite +
drizzle already ship, but only inside `packages/aggregator` (attestations/adoption — network data,
ephemeral in local mode). Nothing indexes local transcripts. Consequences:

- **No incremental updates** — a single new session invalidates a whole-file-set cache.
- **No indexed queries** — "which sessions used skill X in project Y in the last 30 days" means
  scanning every file.
- **No search** — all reads are count aggregation feeding an LLM; there is no keyword or semantic
  retrieval over transcript content anywhere in the codebase.

## Goals

1. **Incremental, not stateless** — parse each transcript once; on a new/changed session, reparse
   only that file and update the store. Turn the ~4s cold scan into a one-time index build and
   sub-second steady state.
2. **A durable substrate** the later search phases build on, using the DB engine we already depend on
   (PGlite / Postgres) — **no second embedded engine** (this supersedes the original "sqlite-vec"
   framing; sqlite-vec would duplicate PGlite).
3. **Hold the privacy line.** The index stores only what today's scan already derives. Raw transcript
   *content* and embeddings are gated behind explicit later phases and an explicit consent boundary.

Non-goals (this phase): changing any `/usage` response shape; indexing message bodies; embeddings.

## Why PGlite, not SQLite + sqlite-vec

- PGlite (`@electric-sql/pglite@0.5.3`) is already a dependency and already drives the aggregator.
  Adding SQLite + sqlite-vec would run **two** embedded DB engines for one job.
- Postgres gives `tsvector` full-text search **in-engine** (Phase 2) and `pgvector` for semantic
  search (Phase 3) — the exact capabilities the phased roadmap needs — with no new engine.
- The aggregator proves the pattern: `new PGlite(dataDir)` for local, swap to hosted Postgres via
  `DATABASE_URL`. The transcript index is **local-only** (a user's own machine state), so it always
  uses the on-disk PGlite path — no hosted mode.

## The engine constraint that shapes the roadmap

**Anthropic has no embeddings API.** We ship `@anthropic-ai/sdk`, but Phase 3 (`pgvector`) needs
vectors from Voyage AI (Anthropic's recommended partner), OpenAI, or a local model — and embedding
transcript *content* means content leaves the device, which cuts against AgentGem's core posture
("secrets never leave your device"; `packages/insight/src/scrub.ts` deliberately discards content).
So Phase 3 is not just "add a column": it requires choosing a provider **and** a consent gate over
what content may leave. Phases 1–2 need neither — they stay fully local — which is why the roadmap is
ordered index → FTS → vectors, each phase independently shippable and independently valuable.

## Roadmap

### Phase 1 — Persistent incremental index (this change)

A local on-disk PGlite database at `~/.agentgem/index/` holding **per-transcript** resolved global
usage, so `scope=global` aggregates from the store and only reparses files that changed.

**Why per-file rows aggregate exactly.** `scanWorkflow` keys an artifact's `sessionsUsedIn` by the
**file path** (`workflowScan.ts` `touch(...)` is called with `path` as the session id). So for a
single transcript, every artifact contributes `sessionsUsedIn ∈ {0,1}`, and across files the global
result is a pure fold:

- `invocations` = SUM over files
- `sessionsUsedIn` = SUM over files (each file is 0 or 1)
- `lastUsedMs` = MAX over files

Therefore `computeGlobalUsage(allPaths)` **==** merge of `computeGlobalUsage([path])` per file. The
index stores each file's contribution and re-folds on read — behavior-identical to the current scan.

Schema (raw SQL; the store is tiny and single-writer, so drizzle's migration machinery isn't earned
here — Phase 2/3 can adopt drizzle if the schema grows):

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);              -- schema_version, inv_digest
CREATE TABLE transcript_file (
  path      TEXT PRIMARY KEY,
  mtime_ms  DOUBLE PRECISION NOT NULL,
  size      DOUBLE PRECISION NOT NULL
);
CREATE TABLE global_usage (                                        -- per-file resolved contribution
  path            TEXT NOT NULL,
  type            TEXT NOT NULL,
  name            TEXT NOT NULL,
  invocations     INTEGER NOT NULL,
  sessions_used_in INTEGER NOT NULL,                               -- 0 or 1
  last_used_ms    DOUBLE PRECISION,
  PRIMARY KEY (path, type, name)
);
CREATE INDEX global_usage_agg ON global_usage (type, name);
```

**Sync algorithm** (`syncGlobalUsage(paths, invDigest, parseFile)`):

1. **Inventory digest guard.** Resolution of raw tool calls → named artifacts depends on the *global
   inventory* (installed skills/MCP/hooks). If `inv_digest` in `meta` differs from the current digest,
   the stored resolved rows are stale → `TRUNCATE global_usage, transcript_file` and store the new
   digest. (Inventory changes rarely — installing a skill — so a full rebuild then is acceptable.
   Phase 2 can store *raw* signal to make the store inventory-independent and drop this rebuild.)
2. **Diff by identity.** For each current path, compare `(mtime_ms, size)` to the stored row. Unchanged
   → skip. New/changed → `parseFile(path)` (runs `scanWorkflow([path], scanInv)`), replace that path's
   `global_usage` rows, upsert `transcript_file`.
3. **Prune.** Delete `transcript_file` + `global_usage` rows for paths no longer on disk.
4. **Fold.** `SELECT type, name, SUM(invocations), SUM(sessions_used_in), MAX(last_used_ms)
   FROM global_usage GROUP BY type, name` → `GlobalUsageResult`.

Steps 2–3 run in one transaction. Concurrent calls are single-flighted with a module-level promise
mutex (the SWR path can fire overlapping refreshes). `parseFile` and `invDigest` are **injected**, so
the index core is testable without touching real config/introspection.

**Endpoint cut-over** (`GET /api/usage?scope=global`): route through the index first; on **any** error,
fall back to the existing token-cache + SWR + full-scan path unchanged. Cold first call still parses
everything once (same ~4s as today) but persists; subsequent opens after new sessions reparse only the
delta → sub-second. The old JSON cache stays as the fallback safety net this phase; it can be retired
once the index has proven out.

**Privacy:** `global_usage` holds only `(type, name, counts, mtime)` — the same derived signal the
current response already exposes. No message content, no prose, no secrets. Same posture as today.

### Phase 2 — Keyword / full-text search (`tsvector`)

Add a `session` table (one row per transcript: `session_id, path, cwd, first_ms, last_ms, model`) and a
`session_fts` column (`tsvector`) built from **scrubbed** text (`scrub.ts`) — mission hint, tool verbs,
resolved artifact names — never raw content. Enables `find sessions about "X"` via `@@ to_tsquery`
without an external API; content stays local. Reuses the same incremental sync (upsert per changed
file). New read endpoint; no change to existing aggregation endpoints.

### Phase 3 — Semantic search (`pgvector`)

Add `pgvector`, an `embedding vector(N)` column, and an embeddings provider (Voyage/OpenAI/local —
decision deferred to that phase's design). **Gated:** requires explicit opt-in and a defined boundary
for what content may leave the device; default-off, honoring the redaction posture. Semantic recall
over session goals/outcomes; the insights layer already LLM-judges sessions, so this makes that
queryable.

## Risks & mitigations

- **Behavioral regression on `scope=global`.** Mitigated by the exact-fold proof above, a fallback to
  the old path on any index error, and unit tests asserting index output == direct-scan output.
- **Corrupt/locked DB file.** All index ops are best-effort; failure throws → endpoint falls back to
  the live scan. A future `--reset-index` (or auto-wipe on open failure) can recover.
- **Stale after inventory change.** Digest guard rebuilds; correct, just not incremental that once.
- **Multiple server processes on one machine.** PGlite is single-writer; the mutex covers in-process
  concurrency, and cross-process races degrade to a redundant reparse, not corruption (upserts are
  idempotent). Documented; revisit if it bites.

## Rollout

Phase 1 ships behind the existing endpoint with a live-scan fallback, so it is safe by construction:
if the index misbehaves, users transparently get today's behavior. Phases 2–3 are additive new
endpoints/columns and get their own designs.
