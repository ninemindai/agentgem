// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/aggregator/detection.ts
import { sql } from "drizzle-orm";
import type { AppDb } from "./schema.js";

/** Tuning for {@link sweepQuarantine}. Each falls back to an env var, then a conservative default. */
export interface SweepOpts {
  minProducers?: number;      // C: a shape must be shared by >= this many distinct producers
  minShape?: number;          // S: the shape must have >= this many skill/mcp ingredients (specificity guard)
  freshMaxAttest?: number;    // a producer with attest_count <= this is "fresh" (single/low-use sybil key)
  freshFraction?: number;     // F: >= this fraction of the cluster's producers must be fresh (freshness guard)
  coreMinProducers?: number;  // ingredients used by fewer than this many distinct producers are treated as padding noise and dropped before fingerprinting
  dryRun?: boolean;           // if true, compute targets but do not UPDATE — counts reflect what would happen
}

export interface SweepReport {
  clustersFound: number;          // coordinated clusters matching all three conditions
  attestationsQuarantined: number;
  producersFlagged: number;
  dryRun: boolean;                // mirrors opts.dryRun — false means updates were applied
}

const num = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/**
 * Statistical detection of coordinated/sybil attestation clusters, then quarantine.
 *
 * A "shape" is the count-independent sorted set of an attestation's public skill/mcp ingredient ids
 * (harness/model excluded — low entropy). The shape is computed over the **core** — ingredients used
 * by >= `coreMinProducers` distinct producers — so per-attestation padding noise is stripped before
 * clustering, defeating the padding-evasion attack where a sybil adds a unique junk ingredient per
 * attestation to break exact-shape matching. A shape is a coordinated cluster when it is shared by
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
  const coreMinProducers = opts.coreMinProducers ?? num(process.env.DETECT_CORE_MIN_PRODUCERS, 3);

  const dryRun = opts.dryRun ?? false;
  // Quarantine targets: attestations in a flagged shape that are not already quarantined
  // AND whose producer is NOT GitHub-bound (verified producers are the anti-sybil anchor).
  // Real mode UPDATEs them; dry-run just counts them.
  const updCte = dryRun
    ? sql``
    : sql`, upd as (
        update attestations set quarantined = true, trust_score = 0
        where id in (select id from targets) returning id, producer_pubkey
      )`;
  const countFrom = dryRun ? sql`targets` : sql`upd`;
  const pkCol = dryRun ? sql`pk` : sql`producer_pubkey`;

  const r = await db.execute<{ clusters_found: number; attestations_quarantined: number; producers_flagged: number }>(sql`
    with ing_freq as (
      -- global distinct-producer count per tool ingredient; padding junk is near-unique (count ~1)
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
      join ing_freq f on f.iid = e.ingredient_id and f.prod_count >= ${coreMinProducers}
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
    targets as (
      select s.aid as id, a.producer_pubkey as pk
      from shapes s
      join bad b on b.fp = s.fp
      join attestations a on a.id = s.aid
      where not a.quarantined
        and not exists (select 1 from account_bindings ab where ab.pubkey = a.producer_pubkey)
    )${updCte}
    select (select count(*) from bad)::int as clusters_found,
           (select count(*) from ${countFrom})::int as attestations_quarantined,
           (select count(distinct ${pkCol}) from ${countFrom})::int as producers_flagged
  `);
  const row = r.rows[0];
  return {
    clustersFound: Number(row.clusters_found),
    attestationsQuarantined: Number(row.attestations_quarantined),
    producersFlagged: Number(row.producers_flagged),
    dryRun,
  };
}
