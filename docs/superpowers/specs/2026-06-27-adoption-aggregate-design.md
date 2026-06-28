# Aggregator — adoption-over-time aggregate (#30, first slice) — Design

**Date:** 2026-06-27
**Status:** Shipped. Builds on the B1 aggregator + public-read CORS (both on `main`).

## Goal

Answer "is `skill:X` actually **growing** in adoption over time?" — a third public read alongside `popularity` and `co-occurrence`, k-anonymized per time bucket. (The co-occurrence-matrix *export* half of #30 is deferred — lower value, separate slice.)

## Rule

`adoption(db, { id, bucket?, k? })` — for one ingredient, a time series of **distinct producers per time bucket**:

- bucket = `date_trunc(bucket, attestations.ingested_at)`, `bucket ∈ {'week','month'}` (default `week`, whitelisted in JS — never a raw caller value).
- `not quarantined` excluded (so detection/quarantine flows through here too).
- **k-anon per bucket:** `having count(distinct producer_pubkey) >= k` (`k = DEFAULT_K`); sparse buckets are suppressed, not just sparse ingredients.
- Returns `[{ bucket: 'YYYY-MM-DD', producers, invocations }, …]` ordered chronologically.

Buckets by `ingested_at` (when the attestation arrived) — simplest with what's stored; a producer-**first-use cohort** view is a richer follow-up.

## Surface

- `GET /api/aggregator/adoption?id=&bucket=` on `AggregatorController` (`@agentback/openapi`). Query schema omits `k` — the floor is server policy, same as the other reads.
- Added `/api/aggregator/adoption` to `originGuard`'s `PUBLIC_READ_PATHS` → CORS-open + cross-site-exempt (public read), POST/protected routes unchanged.

## Reuse / invariants

k-anon-in-SQL (bound `${}` params), `not quarantined`, public-read CORS pattern, the controller shape — all reused. No new dependency.

## Tests (drizzle-pglite)

- multi-bucket series with correct per-bucket distinct-producer counts, chronological order; a sparse bucket suppressed at a higher `k`; quarantined attestations excluded; the `/adoption` path is CORS-exempt in `originGuard`.

## Deferred

co-occurrence-matrix export · first-use cohort bucketing · top-growing-across-kind (vs single id) · weighting by trust_score.
