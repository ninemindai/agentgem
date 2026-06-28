# Trust layer (#28) — Statistical detection → quarantine — Design

**Date:** 2026-06-27
**Status:** Approved design, pre-implementation
**Parent:** Trust layer (#28). First slice. Builds on the B1 aggregator (now on `main`).

## Goal

Detect **coordinated / sybil attestation clusters** and **quarantine** them so they are excluded from every public aggregate — the "can't be faked" (PageRank-style) core of the trust layer. Reuses the `attestations.quarantined` column that the aggregates already filter on; no new external dependency (no OAuth, no cron, no endpoint this slice).

## Why this, not velocity caps

The headline k-anon metric is `count(distinct producer_pubkey)`. A single key flooding 1,000 attestations still counts as **one** producer, so per-key velocity caps don't move the ranking. The real attack is **many fresh keys each submitting one identical, fabricated attestation** to push a shape over the floor / up the ranking. This slice attacks exactly that.

## The detection rule

An attestation's **shape fingerprint** = the count-independent sorted set of its public **skill/mcp** ingredient ids (`usage_edges` joined to `ingredients` where `kind in ('skill','mcp')`). Harness and model nodes are **excluded** — they are low-entropy (almost everyone shares `claude-code` + a top model), so including them would dilute the signal; the meaningful coordination signal is the skills+mcps set, which is also exactly what `signal_digest` hashes. (`signal_digest` itself is a *count-dependent* hash and only collides on lazy copy-paste; the count-independent fingerprint also catches count-randomized sybils, so it is the cluster key.)

A fingerprint is a **coordinated cluster** — and its attestations are quarantined — when **all three** hold:

1. **Cluster size:** shared by `>= C` distinct producers (`producer_pubkey`).
2. **Specificity:** the shape has `>= S` ingredients. *(False-positive guard: a 2-item shape shared by 30 people is organic; a 15-item identical shape is scripted — nobody hand-builds the same long set independently.)*
3. **Freshness:** `>= F` (fraction) of the cluster's distinct producers are **fresh** — `attest_count <= FRESH_MAX` (single/low-use keys that exist only to pad this shape). *(False-positive guard: established users who happen to share a shape are exempt.)*

Specificity exempts organically-popular small shapes; freshness exempts established producers. Both are required (the user's "C" choice) — that combination is what separates a sybil farm from real popularity, and both inputs (`usage_edges`, `producers.attest_count`) are already in the schema.

**Action on a qualifying cluster:** set `quarantined = true` (→ excluded from `popularity`/`co-occurrence`, which already `join … and not quarantined`) and set `trust_score = 0` on those attestations (recorded for future trust-weighting; aggregates don't weight by it yet). Reversible (a flag; rows are kept for audit).

**Defaults (env-overridable):** `C = 10` distinct producers, `S = 4` ingredients, `FRESH_MAX = 2`, `F = 0.8`. Conservative — tuned up once real data exists. Only **public** ingredients participate (private ingredients are never rows, so they can't form a public shape — consistent with the public-only graph).

## Component

```
src/aggregator/detection.ts
  sweepQuarantine(db: AppDb, opts?: SweepOpts): Promise<SweepReport>
```

- `SweepOpts = { minProducers?: number; minShape?: number; freshMaxAttest?: number; freshFraction?: number }` — each defaulting from env (`DETECT_MIN_PRODUCERS`, `DETECT_MIN_SHAPE`, `DETECT_FRESH_MAX`, `DETECT_FRESH_FRACTION`) then the constants above.
- `SweepReport = { clustersFound: number; attestationsQuarantined: number; producersFlagged: number }`.
- Pure batch function: computes clusters over the **currently non-quarantined** attestations and mutates `quarantined`/`trust_score`. **Idempotent** — re-running quarantines nothing new (already-quarantined rows are excluded from cluster computation).

**Mechanism (one parameterized `db.execute(sql\`…\`)`):** a CTE pipeline —
- `shapes`: per non-quarantined attestation, over its `usage_edges` joined to `ingredients` filtered to `kind in ('skill','mcp')` → `producer_pubkey`, `string_agg(ingredient_id order by ingredient_id)` as `fp`, `count(*)` as `shape_size` (group by attestation). (An attestation with no skill/mcp ingredients produces no shape row and is never clustered.)
- `clusters`: group `shapes` by `fp` → `count(distinct producer_pubkey)` as `producers`, `max(shape_size)` as `shape_size`, and `avg(case when p.attest_count <= FRESH_MAX then 1 else 0 end)` as `fresh_frac` (join `producers`).
- qualifying `fp` = `producers >= C and shape_size >= S and fresh_frac >= F`.
- `update attestations set quarantined = true, trust_score = 0 where id in (attestations whose fp is qualifying) and not quarantined` — `returning` to count.

All thresholds are bound `${}` params (no string concat).

## Out of scope (deferred follow-ups)

- **Triggering** — a cron / admin endpoint to run the sweep (this slice ships the function + tests only).
- **Online-at-ingest** detection (quarantine on arrival vs batch).
- **`first_seen` burst** signal (coordinated minting in a tight time window) — an additional freshness discriminator.
- **trust_score weighting** in aggregates (currently a hard `quarantined` exclusion; weighted reputation is richer).
- **OAuth account-binding** (#28's other half — the identity anchor).
- **Un-quarantine / review** workflow.

## Testing (drizzle-pglite, in-process, reuses `makeTestDb`)

- **Coordinated cluster quarantined:** `C` distinct fresh producers (`attest_count=1`) each with the *same* `S`-ingredient shape → after sweep, all quarantined, and the shape's ingredients drop out of `popularity` (were above the floor pre-sweep).
- **Organic small shape exempt:** `C` producers sharing a `< S`-ingredient shape → untouched (specificity guard).
- **Established producers exempt:** `C` producers sharing an `S`-ingredient shape but with `attest_count` above `FRESH_MAX` (fresh_frac `< F`) → untouched (freshness guard).
- **Below cluster size exempt:** `< C` producers with an identical specific fresh shape → untouched.
- **Idempotent:** a second `sweepQuarantine` quarantines `0` more (report counts zero).
- **Report accuracy:** `clustersFound` / `attestationsQuarantined` / `producersFlagged` match the constructed fixture.
