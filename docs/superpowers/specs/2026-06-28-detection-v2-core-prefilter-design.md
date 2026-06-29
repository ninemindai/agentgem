# Detection v2 — anti-padding core-frequency prefilter (#44) — Design

**Date:** 2026-06-28
**Status:** Approved (brainstorm). Hardens the shipped `sweepQuarantine` (#18 + #45's dry-run/verified-exemption) against padding evasion. Builds on the current `src/aggregator/detection.ts` on `origin/main`.

## Goal

Make coordinated-cluster detection resistant to **padding evasion**. Today `sweepQuarantine` clusters
attestations by their **exact** tools-only shape fingerprint
(`string_agg(ingredient_id order by ingredient_id)`). A sybil operator defeats this trivially: add **one
unique junk ingredient per attestation**, and every attestation gets a distinct fingerprint, so no two
share a shape and no cluster ever reaches `minProducers`. v2 closes this hole.

## Decision (confirmed)

**Core-frequency prefilter.** Before computing the shape, drop ingredients whose global distinct-producer
count is below a threshold. Padding junk is by definition near-unique (producer-count ~1), so it is
stripped, the padded attestations collapse back to the same **core** fingerprint, and the existing
exact-match clustering re-forms the cluster. Chosen over the pairwise-overlap graph (O(attestation²),
awkward connected-components in SQL) and frequent-itemset mining (combinatorially explosive) — both are
heavier machinery than this first hardening needs.

**Why it can't be gamed:** to evade, the attacker needs each attestation's padding to be *rare* (so it
changes the fingerprint). But rare ⇒ dropped by the prefilter. Padding only survives if it is *popular* —
at which point it is shared structure the detector happily clusters on. The attacker is forced to either
leave the coordinated core visible or stop padding.

## Change — one CTE, everything else preserved

The only change is to the `shapes` CTE in `sweepQuarantine`. A new `ing_freq` CTE computes each tool
ingredient's global distinct-producer count; `shapes` joins it and keeps only ingredients at/above
`coreMinProducers`:

```sql
with ing_freq as (
  select e.ingredient_id as iid, count(distinct a.producer_pubkey) as prod_count
  from usage_edges e
  join attestations a on a.id = e.attestation_id and not a.quarantined
  join ingredients  i on i.id = e.ingredient_id and i.kind in ('skill','mcp')
  group by e.ingredient_id
),
shapes as (
  select e.attestation_id as aid, a.producer_pubkey as pk,
         string_agg(e.ingredient_id, ',' order by e.ingredient_id) as fp,
         count(*) as shape_size
  from usage_edges e
  join attestations a on a.id = e.attestation_id and not a.quarantined
  join ingredients  i on i.id = e.ingredient_id and i.kind in ('skill','mcp')
  join ing_freq f on f.iid = e.ingredient_id and f.prod_count >= ${coreMinProducers}   -- NEW
  group by e.attestation_id, a.producer_pubkey
),
-- clusters / bad / targets / upd / final counts: UNCHANGED, incl. #45 dryRun + verified-exemption
```

Downstream is byte-for-byte the same: `clusters` (producers, max shape_size, fresh_frac), `bad`
(producers ≥ minProducers AND shape_size ≥ minShape AND fresh_frac ≥ freshFraction), `targets` (non-
quarantined, **not GitHub-bound**), the dry-run/real `upd` branch, and the count projection. The prefilter
sits strictly upstream of all of it.

Note `shape_size` now counts only **core** ingredients, so `minShape` correctly measures the size of the
shared, popular core (not padding) — which is the intended specificity guard.

## Parameter — `coreMinProducers`

- New `SweepOpts.coreMinProducers?: number`; env `DETECT_CORE_MIN_PRODUCERS`; **default 3** (via the existing
  `num()` env-or-default helper, same pattern as the other knobs).
- Trade-off: lower keeps more ingredients (more specific shapes, but light junk-reuse survives); higher
  drops more (robust, coarser). **3** strips pure unique-padding (freq 1) and light reuse (freq 2) while
  retaining genuine signal.
- A flagged cluster's shared ingredients are used by ≥ `minProducers` (default 10) producers, so they
  always clear a threshold of 3 — real clusters are unaffected; only noise is stripped.

## Backward compatibility

Existing `detection.test.ts` clusters flag identically: their shared ingredients are used by the whole
(≥ minProducers) cluster ⇒ high frequency ⇒ retained ⇒ same fingerprints. The implementation plan will read
the existing fixtures; if any **positive** case shares an ingredient whose producer-count is below the
default 3, that test passes `coreMinProducers: 1` explicitly so its behavior is preserved without weakening
the production default. Negative cases are unaffected (stripping ingredients can only *reduce* what gets
flagged).

## Error handling

No new failure modes. `coreMinProducers` is a bound `${}` param; an empty/no-core attestation simply
contributes an empty/short shape that fails the `minShape` guard (correctly not flagged). Idempotency is
preserved (already-quarantined attestations remain excluded from `shapes`).

## Testing (drizzle-pglite, extends `src/aggregator/__tests__/detection.test.ts`)

- **Headline — padding evasion defeated:** seed N ≥ minProducers fresh producers sharing a `minShape`-size
  core, each attestation padded with a DISTINCT unique junk ingredient. With `coreMinProducers: 1` (junk
  retained, v1-equivalent) the cluster is NOT flagged (every fingerprint differs); with the default
  prefilter it IS flagged (junk stripped, cores match). One test, two assertions — proves the fix.
- **No false merge:** two sets of producers that share only one popular ingredient but have different cores
  are not merged into a single bogus cluster (distinct core fingerprints ⇒ separate `clusters` rows, each
  below `minProducers`).
- **Verified-exemption still holds:** a padded sybil cluster with one GitHub-bound producer quarantines the
  unbound members but not the bound one (the #45 behavior, now through the prefilter path).
- **Dry-run still holds:** the padded cluster reports would-be counts with `dryRun: true` and no DB change.
- The existing detection assertions remain green (run the whole `detection.test.js` file).

## Scope

**In:** the `ing_freq` prefilter CTE, the `coreMinProducers` opt + `DETECT_CORE_MIN_PRODUCERS` env + doc
comment update, and the tests above.

**Out / deferred:** the `POST /api/aggregator/sweep` endpoint and any scheduler are unchanged — they call
`sweepQuarantine`, which transparently gets stronger. Pairwise-overlap clustering, frequent-itemset mining,
and detection-tuning telemetry are separate, heavier follow-ups.
