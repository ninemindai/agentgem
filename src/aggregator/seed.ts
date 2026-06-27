// src/aggregator/seed.ts
import { randomUUID } from "node:crypto";
import type { DB } from "./db.js";

/** Insert n synthetic producers (pubkey `synthetic:<i>`) each using every ingredient in `ids`,
 *  so aggregates can clear a k-anon floor while real producer volume is still low. */
export async function seedSynthetic(db: DB, n: number, ids: string[]): Promise<number> {
  for (let i = 0; i < n; i++) {
    const pubkey = `synthetic:${i}`;
    await db.query("insert into producers(pubkey) values ($1) on conflict (pubkey) do nothing", [pubkey]);
    const aid = randomUUID();
    await db.query(
      `insert into attestations(id, gem_name, gem_digest, producer_pubkey, harness_id, models, scan_sessions, scan_span_days, signal_digest)
       values ($1,'synthetic',$2,$3,'claude-code','{}',1,1,'synthetic')`,
      [aid, `synthetic:${i}:${randomUUID()}`, pubkey]);
    for (const id of ids) {
      await db.query("insert into ingredients(id, kind, id_kind) values ($1,'skill','plugin') on conflict (id) do nothing", [id]);
      await db.query("insert into usage_edges(attestation_id, ingredient_id, invocations, sessions) values ($1,$2,1,1) on conflict do nothing", [aid, id]);
    }
  }
  return n;
}
