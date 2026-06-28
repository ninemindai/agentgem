// src/aggregator/detection.ts
import { sql } from "drizzle-orm";
import type { AppDb } from "./schema.js";

/** Tuning for {@link sweepQuarantine}. Each falls back to an env var, then a conservative default. */
export interface SweepOpts {
  minProducers?: number;   // C: a shape must be shared by >= this many distinct producers
  minShape?: number;       // S: the shape must have >= this many skill/mcp ingredients (specificity guard)
  freshMaxAttest?: number; // a producer with attest_count <= this is "fresh" (single/low-use sybil key)
  freshFraction?: number;  // F: >= this fraction of the cluster's producers must be fresh (freshness guard)
}

export interface SweepReport {
  clustersFound: number;          // coordinated clusters matching all three conditions
  attestationsQuarantined: number;
  producersFlagged: number;
}

const num = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/**
 * Statistical detection of coordinated/sybil attestation clusters, then quarantine.
 *
 * A "shape" is the count-independent sorted set of an attestation's public skill/mcp ingredient ids
 * (harness/model excluded — low entropy). A shape is a coordinated cluster when it is shared by
 * `>= minProducers` distinct producers, has `>= minShape` ingredients, AND `>= freshFraction` of its
 * producers are fresh (`attest_count <= freshMaxAttest`). Matching attestations get `quarantined=true`
 * (excluded from every aggregate, which already filter `not quarantined`) and `trust_score=0`.
 *
 * Idempotent: already-quarantined attestations are excluded from the cluster computation, so a second
 * run quarantines nothing new.
 */
export async function sweepQuarantine(db: AppDb, opts: SweepOpts = {}): Promise<SweepReport> {
  const minProducers = opts.minProducers ?? num(process.env.DETECT_MIN_PRODUCERS, 10);
  const minShape = opts.minShape ?? num(process.env.DETECT_MIN_SHAPE, 4);
  const freshMax = opts.freshMaxAttest ?? num(process.env.DETECT_FRESH_MAX, 2);
  const freshFraction = opts.freshFraction ?? num(process.env.DETECT_FRESH_FRACTION, 0.8);

  const r = await db.execute<{ clusters_found: number; attestations_quarantined: number; producers_flagged: number }>(sql`
    with shapes as (
      select e.attestation_id as aid, a.producer_pubkey as pk,
             string_agg(e.ingredient_id, ',' order by e.ingredient_id) as fp,
             count(*) as shape_size
      from usage_edges e
      join attestations a on a.id = e.attestation_id and not a.quarantined
      join ingredients  i on i.id = e.ingredient_id and i.kind in ('skill','mcp')
      group by e.attestation_id, a.producer_pubkey
    ),
    clusters as (
      select s.fp,
             count(distinct s.pk) as producers,
             max(s.shape_size) as shape_size,
             (count(distinct s.pk) filter (where p.attest_count <= ${freshMax}))::float
               / nullif(count(distinct s.pk), 0) as fresh_frac
      from shapes s
      join producers p on p.pubkey = s.pk
      group by s.fp
    ),
    bad as (
      select fp from clusters
      where producers >= ${minProducers} and shape_size >= ${minShape} and fresh_frac >= ${freshFraction}
    ),
    upd as (
      update attestations set quarantined = true, trust_score = 0
      where id in (select s.aid from shapes s join bad b on b.fp = s.fp) and not quarantined
      returning id, producer_pubkey
    )
    select (select count(*) from bad)::int as clusters_found,
           (select count(*) from upd)::int as attestations_quarantined,
           (select count(distinct producer_pubkey) from upd)::int as producers_flagged
  `);
  const row = r.rows[0];
  return {
    clustersFound: Number(row.clusters_found),
    attestationsQuarantined: Number(row.attestations_quarantined),
    producersFlagged: Number(row.producers_flagged),
  };
}
