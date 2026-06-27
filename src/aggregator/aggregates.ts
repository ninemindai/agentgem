// src/aggregator/aggregates.ts
import type { DB } from "./db.js";

export async function popularity(
  db: DB, opts: { kind?: string; limit?: number; k?: number } = {},
): Promise<{ id: string; kind: string; producers: number; invocations: number; sessions: number }[]> {
  const k = opts.k ?? 1, limit = opts.limit ?? 100;
  const r = await db.query<{ id: string; kind: string; producers: number; invocations: number; sessions: number }>(
    `select e.ingredient_id as id, i.kind,
            count(distinct a.producer_pubkey)::int as producers,
            sum(e.invocations)::int as invocations, sum(e.sessions)::int as sessions
     from usage_edges e
     join attestations a on a.id = e.attestation_id and not a.quarantined
     join ingredients  i on i.id = e.ingredient_id
     where ($1::text is null or i.kind = $1)
     group by e.ingredient_id, i.kind
     having count(distinct a.producer_pubkey) >= $2
     order by producers desc, invocations desc
     limit $3`,
    [opts.kind ?? null, k, limit]);
  return r.rows;
}

export async function coOccurrence(
  db: DB, opts: { id: string; limit?: number; k?: number },
): Promise<{ id: string; producers: number }[]> {
  const k = opts.k ?? 1, limit = opts.limit ?? 50;
  const r = await db.query<{ id: string; producers: number }>(
    `select e2.ingredient_id as id, count(distinct a.producer_pubkey)::int as producers
     from usage_edges e1
     join usage_edges e2 on e2.attestation_id = e1.attestation_id and e2.ingredient_id <> e1.ingredient_id
     join attestations a on a.id = e1.attestation_id and not a.quarantined
     where e1.ingredient_id = $1
     group by e2.ingredient_id
     having count(distinct a.producer_pubkey) >= $2
     order by producers desc
     limit $3`,
    [opts.id, k, limit]);
  return r.rows;
}
