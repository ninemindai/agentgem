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
