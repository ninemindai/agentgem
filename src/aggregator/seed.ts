// src/aggregator/seed.ts
import { randomUUID } from "node:crypto";
import type { DB } from "./db.js";

/** Insert n synthetic producers (pubkey `synthetic:<i>`) each using every ingredient in `ids`,
 *  so aggregates can clear a k-anon floor while real producer volume is still low. */
export async function seedSynthetic(db: DB, n: number, ids: string[]): Promise<number> {
  let added = 0;
  for (let i = 0; i < n; i++) {
    const pubkey = `synthetic:${i}`;
    // Idempotent: only seed an attestation+edges for a producer we actually inserted.
    // A `returning` row appears only on first insert; on re-seed the producer exists -> skip,
    // so repeated calls never create orphan/duplicate synthetic attestations.
    const ins = await db.query<{ pubkey: string }>(
      "insert into producers(pubkey, attest_count) values ($1, 1) on conflict (pubkey) do nothing returning pubkey", [pubkey]);
    if (ins.rows.length === 0) continue;
    added++;
    const aid = randomUUID();
    await db.query(
      `insert into attestations(id, gem_name, gem_digest, producer_pubkey, harness_id, models, scan_sessions, scan_span_days, signal_digest)
       values ($1,'synthetic',$2,$3,'claude-code','{}',1,1,'synthetic')`,
      [aid, `synthetic:${i}`, pubkey]);
    for (const id of ids) {
      await db.query("insert into ingredients(id, kind, id_kind) values ($1,'skill','plugin') on conflict (id) do nothing", [id]);
      await db.query("insert into usage_edges(attestation_id, ingredient_id, invocations, sessions) values ($1,$2,1,1)", [aid, id]);
    }
  }
  return added;
}
