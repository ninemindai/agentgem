// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/aggregator/aggregates.ts
import { sql } from "drizzle-orm";
import type { AppDb } from "./schema.js";

/** Safe-by-default k-anonymity floor: a caller that forgets to pass `k` must NOT
 *  get un-anonymized single-producer rows. Callers wanting a lower floor (e.g. local
 *  dev with few producers) pass `k` explicitly. The production floor is a config
 *  decision for the hosted slice. */
export const DEFAULT_K = 5;

export async function popularity(
  db: AppDb, opts: { kind?: string; limit?: number; k?: number } = {},
): Promise<{ id: string; kind: string; producers: number; verifiedProducers: number; invocations: number; sessions: number }[]> {
  const k = opts.k ?? DEFAULT_K, limit = opts.limit ?? 100;
  const r = await db.execute<{ id: string; kind: string; producers: number; verifiedProducers: number; invocations: number; sessions: number }>(sql`
    select e.ingredient_id as id, i.kind,
           count(distinct a.producer_pubkey)::int as producers,
           count(distinct b.provider || ':' || b.account_id)::int as "verifiedProducers",
           sum(e.invocations)::int as invocations, sum(e.sessions)::int as sessions
    from usage_edges e
    join attestations a on a.id = e.attestation_id and not a.quarantined
    join ingredients  i on i.id = e.ingredient_id
    left join account_bindings b on b.pubkey = a.producer_pubkey
    where (${opts.kind ?? null}::text is null or i.kind = ${opts.kind ?? null})
      and (${opts.kind ?? null}::text is not null or i.kind in ('skill','mcp'))
    group by e.ingredient_id, i.kind
    having count(distinct a.producer_pubkey) >= ${k}
    order by producers desc, invocations desc
    limit ${limit}
  `);
  return r.rows as { id: string; kind: string; producers: number; verifiedProducers: number; invocations: number; sessions: number }[];
}

/** Cross-model benchmark: per-model outcome counts aggregated across producers,
 *  k-anonymised on distinct producers. Optionally scoped to one gem. Success rate
 *  = mostly / (mostly + partially + notAchieved), computed by the caller. */
export async function modelBenchmark(
  db: AppDb, opts: { gemDigest?: string; limit?: number; k?: number } = {},
): Promise<{ model: string; mostly: number; partially: number; notAchieved: number; producers: number; verifiedProducers: number }[]> {
  const k = opts.k ?? DEFAULT_K, limit = opts.limit ?? 100;
  const r = await db.execute<{ model: string; mostly: number; partially: number; notAchieved: number; producers: number; verifiedProducers: number }>(sql`
    select mo.model,
           sum(mo.mostly)::int as mostly,
           sum(mo.partially)::int as partially,
           sum(mo.not_achieved)::int as "notAchieved",
           count(distinct a.producer_pubkey)::int as producers,
           count(distinct b.provider || ':' || b.account_id)::int as "verifiedProducers"
    from model_outcomes mo
    join attestations a on a.id = mo.attestation_id and not a.quarantined
    left join account_bindings b on b.pubkey = a.producer_pubkey
    where (${opts.gemDigest ?? null}::text is null or a.gem_digest = ${opts.gemDigest ?? null})
    group by mo.model
    having count(distinct a.producer_pubkey) >= ${k}
    order by producers desc, mo.model
    limit ${limit}
  `);
  return r.rows as { model: string; mostly: number; partially: number; notAchieved: number; producers: number; verifiedProducers: number }[];
}

/** Judged sessions needed for the organic score to fully displace the prior
 *  (confidence -> 1). Mirrors SkillGem's `min(1, total/50)` curve. */
export const EFFECTIVENESS_FULL_CONFIDENCE = 50;
/** Neutral prior a low-evidence gem sits at, in place of an author-submitted
 *  benchmark. A gem with no judged sessions scores 50; real outcomes pull it
 *  up or down as confidence grows. */
export const EFFECTIVENESS_PRIOR = 50;

export interface EffectivenessRow {
  gemName: string;
  mostly: number; partially: number; notAchieved: number;
  judged: number;
  producers: number; verifiedProducers: number;
  organic: number;     // 0-100 partial-credit success rate over judged sessions
  confidence: number;  // 0-1, grows with judged-session volume
  score: number;       // 0-100, organic shrunk toward the prior by (1 - confidence)
}

/** Pure effectiveness math, separated from the query so it is unit-testable
 *  without a DB. `partially` counts as half credit (3-level judged outcome).
 *  score = organic*confidence + prior*(1 - confidence), i.e. SkillGem's hybrid
 *  formula with the author benchmark replaced by a neutral prior. */
export function effectivenessScore(
  o: { mostly: number; partially: number; notAchieved: number },
  prior = EFFECTIVENESS_PRIOR,
): { judged: number; organic: number; confidence: number; score: number } {
  const judged = o.mostly + o.partially + o.notAchieved;
  const organic = judged > 0 ? ((o.mostly + 0.5 * o.partially) / judged) * 100 : 0;
  const confidence = Math.min(1, judged / EFFECTIVENESS_FULL_CONFIDENCE);
  const score = organic * confidence + prior * (1 - confidence);
  return { judged, organic, confidence, score };
}

/** Per-gem effectiveness: outcome counts summed across all models and versions
 *  of a gem (grouped by gem_name), k-anonymised on distinct producers, quarantine-
 *  aware — same trust shape as `modelBenchmark`. Each row is passed through
 *  `effectivenessScore` so the confidence-weighted score is materialised here
 *  rather than left to the caller.
 *
 *  `sort: "score"` ranks by the confidence-weighted score (an effectiveness
 *  leaderboard); `minConfidence` gates out gems too sparse to trust (SkillGem
 *  uses `confidence > 0.3`). Both act on the score/confidence, which are derived
 *  in JS — so ranking/gating happen AFTER mapping over the full k-anon set, never
 *  truncated by a producer-ordered SQL LIMIT. k-anon + quarantine stay in SQL. */
export async function effectiveness(
  db: AppDb,
  opts: { gemName?: string; limit?: number; k?: number; sort?: "producers" | "score"; minConfidence?: number } = {},
): Promise<EffectivenessRow[]> {
  const k = opts.k ?? DEFAULT_K, limit = opts.limit ?? 100, minConfidence = opts.minConfidence ?? 0;
  const r = await db.execute<{ gemName: string; mostly: number; partially: number; notAchieved: number; producers: number; verifiedProducers: number }>(sql`
    select a.gem_name as "gemName",
           sum(mo.mostly)::int as mostly,
           sum(mo.partially)::int as partially,
           sum(mo.not_achieved)::int as "notAchieved",
           count(distinct a.producer_pubkey)::int as producers,
           count(distinct b.provider || ':' || b.account_id)::int as "verifiedProducers"
    from model_outcomes mo
    join attestations a on a.id = mo.attestation_id and not a.quarantined
    left join account_bindings b on b.pubkey = a.producer_pubkey
    where (${opts.gemName ?? null}::text is null or a.gem_name = ${opts.gemName ?? null})
    group by a.gem_name
    having count(distinct a.producer_pubkey) >= ${k}
  `);
  const rows = (r.rows as { gemName: string; mostly: number; partially: number; notAchieved: number; producers: number; verifiedProducers: number }[])
    .map((row) => ({ ...row, ...effectivenessScore(row) }));
  const gated = minConfidence > 0 ? rows.filter((x) => x.confidence >= minConfidence) : rows;
  gated.sort(opts.sort === "score"
    ? (a, b) => b.score - a.score || b.producers - a.producers || a.gemName.localeCompare(b.gemName)
    : (a, b) => b.producers - a.producers || a.gemName.localeCompare(b.gemName));
  return gated.slice(0, limit);
}

export async function coOccurrence(
  db: AppDb, opts: { id: string; limit?: number; k?: number },
): Promise<{ id: string; producers: number; verifiedProducers: number }[]> {
  const k = opts.k ?? DEFAULT_K, limit = opts.limit ?? 50;
  const r = await db.execute<{ id: string; producers: number; verifiedProducers: number }>(sql`
    select e2.ingredient_id as id,
           count(distinct a.producer_pubkey)::int as producers,
           count(distinct b.provider || ':' || b.account_id)::int as "verifiedProducers"
    from usage_edges e1
    join usage_edges e2 on e2.attestation_id = e1.attestation_id and e2.ingredient_id <> e1.ingredient_id
    join ingredients i2 on i2.id = e2.ingredient_id and i2.kind in ('skill','mcp')
    join attestations a on a.id = e1.attestation_id and not a.quarantined
    left join account_bindings b on b.pubkey = a.producer_pubkey
    where e1.ingredient_id = ${opts.id}
    group by e2.ingredient_id
    having count(distinct a.producer_pubkey) >= ${k}
    order by producers desc
    limit ${limit}
  `);
  return r.rows as { id: string; producers: number; verifiedProducers: number }[];
}

export async function overview(
  db: AppDb, opts: { k?: number } = {},
): Promise<{ ingredients: number; producers: number; verifiedProducers: number; invocations: number; sessions: number }> {
  const k = opts.k ?? DEFAULT_K;
  const r = await db.execute<{ ingredients: number; producers: number; verifiedProducers: number; invocations: number; sessions: number }>(sql`
    select
      count(distinct e.ingredient_id)::int                   as ingredients,
      count(distinct a.producer_pubkey)::int                 as producers,
      count(distinct b.provider || ':' || b.account_id)::int as "verifiedProducers",
      coalesce(sum(e.invocations), 0)::int                   as invocations,
      coalesce(sum(e.sessions), 0)::int                      as sessions
    from usage_edges e
    join attestations a on a.id = e.attestation_id and not a.quarantined
    join ingredients i on i.id = e.ingredient_id and i.kind in ('skill', 'mcp')
    left join account_bindings b on b.pubkey = a.producer_pubkey
  `);
  const row = r.rows[0] ?? { ingredients: 0, producers: 0, verifiedProducers: 0, invocations: 0, sessions: 0 };
  // Safe-by-default: a whole network below the floor exposes nothing (mirrors popularity's HAVING).
  if (row.producers < k) return { ingredients: 0, producers: 0, verifiedProducers: 0, invocations: 0, sessions: 0 };
  return row;
}

export async function coOccurrenceMatrix(
  db: AppDb, opts: { limit?: number; k?: number } = {},
): Promise<{ a: string; b: string; producers: number; verifiedProducers: number }[]> {
  const k = opts.k ?? DEFAULT_K, limit = opts.limit ?? 500;
  const r = await db.execute<{ a: string; b: string; producers: number; verifiedProducers: number }>(sql`
    select e1.ingredient_id as a, e2.ingredient_id as b,
           count(distinct at.producer_pubkey)::int as producers,
           count(distinct bnd.provider || ':' || bnd.account_id)::int as "verifiedProducers"
    from usage_edges e1
    join usage_edges e2 on e2.attestation_id = e1.attestation_id and e1.ingredient_id < e2.ingredient_id
    join ingredients i1 on i1.id = e1.ingredient_id and i1.kind in ('skill','mcp')
    join ingredients i2 on i2.id = e2.ingredient_id and i2.kind in ('skill','mcp')
    join attestations at on at.id = e1.attestation_id and not at.quarantined
    left join account_bindings bnd on bnd.pubkey = at.producer_pubkey
    group by e1.ingredient_id, e2.ingredient_id
    having count(distinct at.producer_pubkey) >= ${k}
    order by producers desc, a, b
    limit ${limit}
  `);
  return r.rows as { a: string; b: string; producers: number; verifiedProducers: number }[];
}

export async function gemAdoption(
  db: AppDb, opts: { keys?: string[]; k?: number } = {},
): Promise<{ gemKey: string; installs: number; verifiedInstalls: number }[]> {
  const k = opts.k ?? DEFAULT_K;
  // PGlite does not accept JS arrays cast to text[] via drizzle params; build the filter with
  // individually-bound params joined into ARRAY[...] so each element is a safe $N placeholder.
  const keys = opts.keys && opts.keys.length ? opts.keys : null;
  const keysFilter = keys
    ? sql`g.gem_key = any(array[${sql.join(keys.map((key) => sql`${key}`), sql.raw(", "))}])`
    : sql`true`;
  const r = await db.execute<{ gemKey: string; installs: number; verifiedInstalls: number }>(sql`
    select g.gem_key as "gemKey",
           count(distinct g.producer_pubkey)::int as installs,
           count(distinct b.provider || ':' || b.account_id)::int as "verifiedInstalls"
    from gem_adoptions g
    left join account_bindings b on b.pubkey = g.producer_pubkey
    where not g.quarantined and (${keysFilter})
    group by g.gem_key
    having count(distinct g.producer_pubkey) >= ${k}
    order by installs desc
  `);
  return r.rows as { gemKey: string; installs: number; verifiedInstalls: number }[];
}

export async function adoption(
  db: AppDb, opts: { id: string; bucket?: "week" | "month"; k?: number },
): Promise<{ bucket: string; producers: number; verifiedProducers: number; invocations: number }[]> {
  const k = opts.k ?? DEFAULT_K;
  const bucket = opts.bucket === "month" ? "month" : "week"; // whitelist; never a raw caller value
  const r = await db.execute<{ bucket: string; producers: number; verifiedProducers: number; invocations: number }>(sql`
    select to_char(date_trunc(${bucket}, a.ingested_at), 'YYYY-MM-DD') as bucket,
           count(distinct a.producer_pubkey)::int as producers,
           count(distinct b.provider || ':' || b.account_id)::int as "verifiedProducers",
           sum(e.invocations)::int as invocations
    from usage_edges e
    join attestations a on a.id = e.attestation_id and not a.quarantined
    left join account_bindings b on b.pubkey = a.producer_pubkey
    where e.ingredient_id = ${opts.id}
    group by 1
    having count(distinct a.producer_pubkey) >= ${k}
    order by 1
  `);
  return r.rows as { bucket: string; producers: number; verifiedProducers: number; invocations: number }[];
}
