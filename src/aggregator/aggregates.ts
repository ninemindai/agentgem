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
): Promise<{ id: string; kind: string; producers: number; invocations: number; sessions: number }[]> {
  const k = opts.k ?? DEFAULT_K, limit = opts.limit ?? 100;
  const r = await db.execute<{ id: string; kind: string; producers: number; invocations: number; sessions: number }>(sql`
    select e.ingredient_id as id, i.kind,
           count(distinct a.producer_pubkey)::int as producers,
           sum(e.invocations)::int as invocations, sum(e.sessions)::int as sessions
    from usage_edges e
    join attestations a on a.id = e.attestation_id and not a.quarantined
    join ingredients  i on i.id = e.ingredient_id
    where (${opts.kind ?? null}::text is null or i.kind = ${opts.kind ?? null})
    group by e.ingredient_id, i.kind
    having count(distinct a.producer_pubkey) >= ${k}
    order by producers desc, invocations desc
    limit ${limit}
  `);
  return r.rows as { id: string; kind: string; producers: number; invocations: number; sessions: number }[];
}

export async function coOccurrence(
  db: AppDb, opts: { id: string; limit?: number; k?: number },
): Promise<{ id: string; producers: number }[]> {
  const k = opts.k ?? DEFAULT_K, limit = opts.limit ?? 50;
  const r = await db.execute<{ id: string; producers: number }>(sql`
    select e2.ingredient_id as id, count(distinct a.producer_pubkey)::int as producers
    from usage_edges e1
    join usage_edges e2 on e2.attestation_id = e1.attestation_id and e2.ingredient_id <> e1.ingredient_id
    join attestations a on a.id = e1.attestation_id and not a.quarantined
    where e1.ingredient_id = ${opts.id}
    group by e2.ingredient_id
    having count(distinct a.producer_pubkey) >= ${k}
    order by producers desc
    limit ${limit}
  `);
  return r.rows as { id: string; producers: number }[];
}
