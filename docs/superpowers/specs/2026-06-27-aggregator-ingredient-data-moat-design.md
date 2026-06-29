# Hosted Aggregator — Ingredient Data Moat (Spec B1)

**Date:** 2026-06-27
**Status:** Approved design, pre-implementation
**Part of:** the three-subsystem vision — A. Producer ([Spec A](2026-06-26-distill-usage-attestation-design.md)), **B. Aggregator (this spec)**, C. Trust spine. Spec B decomposes into **B1 — ingredient data moat (this doc)** and **B2 — Gem marketplace (fast-follow)**.

> **Amendment 2026-06-27 (Codex adversarial debate):** baseline attestations are signed *self-reported telemetry*, not proof of real use (see [Spec A 2026-06-27 #2](2026-06-26-distill-usage-attestation-design.md)). B1 must therefore treat trust as **reputation, not cryptography**:
> - **k-anonymity and every "distinct producers" count are over TRUSTED producers, not raw accounts.** Self-minted keys + cheap OAuth accounts give continuity, not scarcity, so a raw-account K is pumpable *and* (worse) suppresses exactly the long-tail co-occurrences that are most valuable. A producer earns trust weight from aged account, verified org/domain, payment method on file, package ownership, and prior reputation; apply **velocity caps per account/org/time bucket**. Seed the graph with first-party/customer cohorts and expose only broad categories until trusted volume exists.
> - **Statistical detection is abuse triage, NOT trust.** Plausibility checks are shapeable across sybils, so they only gate abuse review; trust comes from reputation + (future) receipts.
> - **Honest tiers in ranking.** Only receipt-backed records may power trust-sensitive rankings (and royalties later). Baseline (self-reported) records build aggregate insights but are labeled and reputation-weighted.
> - **Dedup + separate metrics.** Dedup near-identical Gems by normalized content/procedure fingerprint; cap per account/org/time. Report **"Gem popularity"** and **"ingredient mention volume"** as separate metrics so one can't inflate the other.
> - **No split-brain.** Ingest requires the archive bytes or a server-fetched registry ref; an attestation without a resolvable Gem is stored as **low-trust telemetry, not counted Gem usage.**
> - **Graph engine.** Default is relational tables + materialized aggregates + **batch-computed PageRank out of the request path**; Apache AGE is *not assumed* (managed-Postgres / Vercel constraints) and is deferred until traversal genuinely hurts.
> - **Verified-tier input is now minimal salted tuples** (`{ saltedSessionId, ingredientId, count, coarseTimeBucket }`), renamed **"recomputable"** — see the Spec A amendment. The full `WorkflowSignal` is never ingested.

## North star

Same priority order as Spec A: **data moat first**, trust second, acquisition third. B1 is the data moat made real — it ingests the [Spec A](2026-06-26-distill-usage-attestation-design.md) usage attestations and turns them into a queryable graph of *real AI usage* (harnesses × models × skills × MCP servers/tools). B2 (the public Gem leaderboard + social + selling) reuses B1's ingest and graph but is a separate spec.

## Key decisions (resolved during brainstorming)

1. **Ingest substrate: a hosted ingest endpoint (revised — was hybrid).** Producers **POST the signed attestation to a hosted ingest API** that verifies *at the door* and projects into the DB; identity is established via **OAuth** (Sign in with Vercel / GitHub OAuth). The GitHub-backed registry remains the durable, content-addressed store for **distributing installable Gems only** — it is *not* the data-ingest path. Rationale: a git repo is a poor high-write ingest substrate (serialized commits, repo bloat, API rate limits) exactly when the data moat starts working, it couples producer identity to GitHub-repo write access, and a push-then-quarantine model can never reject at the door. Decoupling data ingest from Gem distribution removes all three. Cost: this reopens Spec A's publish path (`sign_and_publish` now also POSTs to the API) and replaces the free commit-author binding with OAuth — captured in the [Spec A 2026-06-27 amendment](2026-06-26-distill-usage-attestation-design.md). Deterministic verification failures are **rejected (4xx) at the door**; records that pass but look anomalous are **quarantined** (withheld from aggregates).
2. **Ranked surfaces: both, ingredient-first.** B1 ships the **ingredient/insights view** (the defensible asset); the **Gem marketplace leaderboard** is B2. They share one graph.
3. **Storage: Postgres now; graph-native later only if needed.** Day-one queries are aggregations over a mostly *bipartite* graph (Gem ↔ ingredient), which Postgres handles well. If/when fork-graph PageRank needs real traversal, add the **Apache AGE / pgGraph** extension *inside* Postgres rather than standing up a separate engine — so "graph-native later" need not mean "new infra later."
4. **Trust: tiered (Decision = 3, revised — see amendment above).** Universal **statistical detection** baseline + an opt-in audit-visible **"recomputable"** tier: records may ship **minimal salted event tuples** (`{ saltedSessionId, ingredientId, count, coarseTimeBucket }`) the aggregator deterministically recomputes declared counts against. The full `WorkflowSignal` is **never** ingested. The word **"verified"** is reserved for a future **harness/provider-signed run receipt** — the only artifact that proves a real run — *not* for self-reported telemetry. (Supersedes the earlier `evidence.signal` / "verified badge" design; see the [Spec A 2026-06-27 amendment](2026-06-26-distill-usage-attestation-design.md) — `evidence.signal` was dropped and the tier renamed "recomputable".)
5. **Exposure: tiered (Decision = 2), with a hard k-anonymity floor.** A **public teaser UI** (headline trends) drives acquisition; a **gated/billed data API** (deeper queries) is the data-provider business. **Every exposed number is aggregated over ≥ K distinct producers, enforced server-side** — no query can reveal one producer's private usage. Rare ingredients stay hidden until ≥ K producers use them (accepted trade-off).

## Architecture

```
producer ──POST signed attestation (OAuth)──► hosted ingest API
GitHub registry = distribution only            │ verify at the door:
(installable Gems, separate channel)           │   ed25519 signature
                                               │   account = OAuth identity
                                               │   recomputable? recompute vs salted tuples
                                               │   deterministic fail → 4xx REJECT
                                               │ statistical trust_score → quarantine?
                                               ▼
                                       Postgres (usage graph)
                                               │ cron refresh
                                    materialized aggregates (k-anon ≥ K)
                                       │                         │
                            public teaser UI            gated/billed data API
                            (headline trends)           (auth + rate limit, k-anon)
```

Next.js App Router on Vercel (Fluid Compute), Postgres via Vercel Marketplace, Vercel Blob for the stored attestation/archive bytes, cron for aggregate refresh + periodic statistical sweeps. No AI Gateway needed.

## Ingest pipeline (hosted endpoint)

The producer (Spec A `sign_and_publish`) POSTs the signed attestation to the ingest API over an OAuth session. Per request, synchronously enough to return a verdict:

1. **Authn** — resolve the OAuth identity; it must match `attestation.producer.account`. Mismatch → `401/403`.
2. **Signature** — verify ed25519 over the canonical attestation; record `producer.publicKey`. Invalid → `400`.
3. **Integrity** — if the archive bytes are included, `readGemArchive` + `verifyLock`; `attestation.gem.digest` must match. Mismatch → `400`.
4. **Recomputable tier** — if the record ships the minimal **salted event tuples** (`{ saltedSessionId, ingredientId, count, coarseTimeBucket }`): verify `signalDigest` as a tamper-evident commitment, recompute declared ingredient counts against the tuples, **reject (`422`) any record whose declared counts exceed the tuples**; on pass, `tier = recomputable` (audit-visible, higher weight). The full `WorkflowSignal` is never ingested.
5. **Baseline tier** — otherwise `signalDigest` is a tamper-evident commitment only; `tier = baseline`.
6. **Statistical detection** (see below) → `trust_score`; below threshold → `quarantined = true` (accepted but excluded from all aggregates).
7. Upsert canonical `ingredients`; insert the `attestation` row + its `usage_edges`; persist bytes to Blob. Return `{ ingestId, tier, accepted | quarantined }`.
8. Aggregates refresh incrementally (or via cron).

Ingest is **idempotent on `gem.digest`** (re-POSTing the same record is safe and returns the prior verdict). Steps 1–4 are door-rejections (the producer gets a hard error); only step 6 results in silent quarantine.

## Schema (the usage graph)

- **`attestations`** — one row per ingested record: `gem_name`, `gem_version`, `gem_digest` (unique), `producer_pubkey`, `account_provider`, `account_login`, `harness_id`, `harness_version`, `scan_sessions`, `scan_span_days`, `scan_first_ms`, `scan_last_ms`, `signal_digest`, `tier` (`baseline`|`recomputable`), `trust_score`, `quarantined`, `blob_ref` (stored attestation/archive bytes in Vercel Blob), `registry_ref` (nullable — set when the Gem was also published for distribution), `ingested_at`.
- **`ingredients`** — canonical node per ingredient: `id` (canonical PK), `kind` (`harness`|`model`|`skill`|`mcp`|`tool`), `id_kind` (confidence: `registry`/`contentHash`/`name`/`package`/`url`/`known`/`unknown`), `display_name`, `parent_id` (tool → its server), `first_seen`, `last_seen`.
- **`usage_edges`** — bipartite edges: `attestation_id`, `ingredient_id`, `invocations`, `sessions`. (Unique on the pair.)
- **Materialized aggregates** (all k-anon-filtered, refreshed by cron):
  - `ingredient_popularity` — per ingredient: distinct producers, total invocations, sessions, time buckets.
  - `co_occurrence` — per ingredient pair: distinct-producer count (the "what pairs with X" matrix).
  - `adoption_over_time` — per ingredient/kind: distinct producers per week.

Quarantined attestations and their edges are excluded from every aggregate. **Forward door:** the AGE/pgGraph extension can later add openCypher traversal + PageRank over a fork-edge table without leaving Postgres.

## Trust at ingest

- **Deterministic (both tiers), enforced at the door as 4xx rejections:** OAuth identity = `producer.account`, ed25519 signature, `verifyLock` + `gem.digest` match.
- **Recomputable tier:** recompute declared counts vs the salted event tuples; inflation is rejected outright (`422`).
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

- **Ingest endpoint** — fixtures for valid baseline (accepted), valid recomputable (accepted), tampered signature (`400`), mismatched OAuth identity (`401/403`), `gem.digest` mismatch (`400`), and an **injected fabricated record that passes door checks → quarantined**. Re-POST of the same `gem.digest` → idempotent, same verdict.
- **Recomputable-tier recompute** — inflated declared counts vs the salted tuples → `422`.
- **k-anon enforcement** — property test: no aggregate endpoint ever emits a cell with `< K` distinct producers (UI and API).
- **Aggregate correctness** — popularity/co-occurrence/adoption match hand-computed fixtures.
- **API contract + rate limit** — auth required, shapes stable, limits enforced.
- **Schema migrations** — up/down clean.

## Out of scope (later specs)

- **B2** — public Gem marketplace leaderboard, social signals (stars/reviews/downloads), selling/commerce. Reuses B1's ingest + graph.
- Fork/dependency edges + **PageRank** ranking, install-attested provenance receipts, content-hash edge inference (the dependency-graph spec; AGE/pgGraph door noted above).
- Harness/provider-signed run receipts — the true **"verified"** tier (proves a real run), beyond the audit-visible **"recomputable"** salted-tuple tier.
- Standalone usage report with no Gem (still deferred from Spec A).
