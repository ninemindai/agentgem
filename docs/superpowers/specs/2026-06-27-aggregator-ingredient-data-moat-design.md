# Hosted Aggregator — Ingredient Data Moat (Spec B1)

**Date:** 2026-06-27
**Status:** Approved design, pre-implementation
**Part of:** the three-subsystem vision — A. Producer ([Spec A](2026-06-26-distill-usage-attestation-design.md)), **B. Aggregator (this spec)**, C. Trust spine. Spec B decomposes into **B1 — ingredient data moat (this doc)** and **B2 — Gem marketplace (fast-follow)**.

## North star

Same priority order as Spec A: **data moat first**, trust second, acquisition third. B1 is the data moat made real — it ingests the [Spec A](2026-06-26-distill-usage-attestation-design.md) usage attestations and turns them into a queryable graph of *real AI usage* (harnesses × models × skills × MCP servers/tools). B2 (the public Gem leaderboard + social + selling) reuses B1's ingest and graph but is a separate spec.

## Key decisions (resolved during brainstorming)

1. **Source-of-truth relationship: hybrid (Decision = 3).** The GitHub-backed registry stays the durable archive store; a hosted **webhook/Action fires on each registry push**, and the service verifies + projects archives into its DB near-real-time. The producer path (Spec A) is **unchanged**. The aggregator cannot *prevent* a bad archive existing in git, but it can **quarantine** (withhold from all aggregates) — which, with later PageRank, is sufficient.
2. **Ranked surfaces: both, ingredient-first.** B1 ships the **ingredient/insights view** (the defensible asset); the **Gem marketplace leaderboard** is B2. They share one graph.
3. **Storage: Postgres now; graph-native later only if needed.** Day-one queries are aggregations over a mostly *bipartite* graph (Gem ↔ ingredient), which Postgres handles well. If/when fork-graph PageRank needs real traversal, add the **Apache AGE / pgGraph** extension *inside* Postgres rather than standing up a separate engine — so "graph-native later" need not mean "new infra later."
4. **Trust: tiered (Decision = 3).** Universal **statistical detection** baseline + an opt-in **"verified" badge** for records that ship `evidence.signal` (deterministic recompute). This drove the [Spec A amendment](2026-06-26-distill-usage-attestation-design.md) adding optional `evidence.signal`.
5. **Exposure: tiered (Decision = 2), with a hard k-anonymity floor.** A **public teaser UI** (headline trends) drives acquisition; a **gated/billed data API** (deeper queries) is the data-provider business. **Every exposed number is aggregated over ≥ K distinct producers, enforced server-side** — no query can reveal one producer's private usage. Rare ingredients stay hidden until ≥ K producers use them (accepted trade-off).

## Architecture

```
registry git push ──webhook/Action──► Vercel Queue ──► ingest worker
                                                          │ readGemArchive + verifyLock
                                                          │ ed25519 signature
                                                          │ account = commit author
                                                          │ verified? recompute vs evidence.signal
                                                          │ statistical trust_score → quarantine?
                                                          ▼
                                               Postgres (usage graph)
                                                          │ cron refresh
                                               materialized aggregates (k-anon ≥ K)
                                                  │                         │
                                       public teaser UI            gated/billed data API
                                       (headline trends)           (auth + rate limit, k-anon)
```

Next.js App Router on Vercel (Fluid Compute), Postgres via Vercel Marketplace, Vercel Queues for at-least-once ingest, cron for aggregate refresh + periodic statistical sweeps. No AI Gateway needed.

## Ingest pipeline (hybrid)

On each registry push, the webhook enqueues changed archive paths. The ingest worker, per archive:

1. `readGemArchive` + `verifyLock` — integrity of manifest + files.
2. Verify the ed25519 `signature` over the canonical attestation; record `producer.publicKey`.
3. Bind account: the registry **commit author** must match `attestation.producer.account`.
4. **Verified tier** — if `evidence.signal` is present: recompute `signalDigest`, recompute ingredient counts from the signal, **reject any record whose declared counts exceed the signal**; mark `tier = verified`, high trust weight.
5. **Baseline tier** — otherwise `signalDigest` is a tamper-evident commitment only; `tier = baseline`.
6. **Statistical detection** (see below) → `trust_score`; below threshold → `quarantined = true` (excluded from all aggregates).
7. Upsert canonical `ingredients`; insert the `attestation` row + its `usage_edges`.
8. Aggregates refresh incrementally (or via cron).

Ingest is idempotent on `gem.digest` (re-processing a push is safe).

## Schema (the usage graph)

- **`attestations`** — one row per ingested record: `gem_name`, `gem_version`, `gem_digest` (unique), `producer_pubkey`, `account_provider`, `account_login`, `harness_id`, `harness_version`, `scan_sessions`, `scan_span_days`, `scan_first_ms`, `scan_last_ms`, `signal_digest`, `tier` (`baseline`|`verified`), `trust_score`, `quarantined`, `archive_ref` (git path+sha), `ingested_at`.
- **`ingredients`** — canonical node per ingredient: `id` (canonical PK), `kind` (`harness`|`model`|`skill`|`mcp`|`tool`), `id_kind` (confidence: `registry`/`contentHash`/`name`/`package`/`url`/`known`/`unknown`), `display_name`, `parent_id` (tool → its server), `first_seen`, `last_seen`.
- **`usage_edges`** — bipartite edges: `attestation_id`, `ingredient_id`, `invocations`, `sessions`. (Unique on the pair.)
- **Materialized aggregates** (all k-anon-filtered, refreshed by cron):
  - `ingredient_popularity` — per ingredient: distinct producers, total invocations, sessions, time buckets.
  - `co_occurrence` — per ingredient pair: distinct-producer count (the "what pairs with X" matrix).
  - `adoption_over_time` — per ingredient/kind: distinct producers per week.

Quarantined attestations and their edges are excluded from every aggregate. **Forward door:** the AGE/pgGraph extension can later add openCypher traversal + PageRank over a fork-edge table without leaving Postgres.

## Trust at ingest

- **Deterministic (both tiers):** `verifyLock` + ed25519 signature + account-binding.
- **Verified tier:** recompute counts vs `evidence.signal`; inflation is rejected outright.
- **Baseline tier — statistical detection** producing `trust_score`:
  - ingredient `invocations`/`sessions` exceeding what `scan.sessions` plausibly supports;
  - publish-velocity spikes per `producer_pubkey` / account;
  - internal impossibilities (e.g. `ingredient.sessions > scan.sessions`);
  - lone-producer edges (an edge no other producer corroborates) — low weight.
- Low `trust_score` → `quarantined`. The k-anon floor is a **second** layer: lone-producer noise never reaches output even if not quarantined.

## Exposure

The **k-anonymity floor (≥ K distinct producers) is enforced server-side on every read path** — UI and API alike.

- **Public teaser UI** (Next.js): headline trends only — top MCP servers, model adoption, a few co-occurrence highlights. The growth/acquisition surface.
- **Gated data API**: auth (API keys / Sign in with Vercel) + billing tiers; deeper queries — full co-occurrence matrices, time-series, segment filters (by harness/model). Rate-limited. Aggregate-only; k-anon enforced in the query layer, not just the UI.

## Testing

- **Ingest worker** — fixtures for valid baseline, valid verified, tampered signature, mismatched account, and an **injected fabricated record → quarantined**.
- **Verified-tier recompute** — inflated counts vs `evidence.signal` are rejected.
- **k-anon enforcement** — property test: no aggregate endpoint ever emits a cell with `< K` distinct producers (UI and API).
- **Aggregate correctness** — popularity/co-occurrence/adoption match hand-computed fixtures.
- **API contract + rate limit** — auth required, shapes stable, limits enforced.
- **Schema migrations** — up/down clean.

## Out of scope (later specs)

- **B2** — public Gem marketplace leaderboard, social signals (stars/reviews/downloads), selling/commerce. Reuses B1's ingest + graph.
- Fork/dependency edges + **PageRank** ranking, install-attested provenance receipts, content-hash edge inference (the dependency-graph spec; AGE/pgGraph door noted above).
- Harness-signed run receipts ("verified++" beyond the `evidence.signal` tier).
- Standalone usage report with no Gem (still deferred from Spec A).
