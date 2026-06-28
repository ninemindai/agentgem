// src/aggregator/seed.ts
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { AppDb } from "./schema.js";

/** Insert n synthetic producers (pubkey `synthetic:<i>`) each using every ingredient in `ids`,
 *  so aggregates can clear a k-anon floor while real producer volume is still low. */
export async function seedSynthetic(db: AppDb, n: number, ids: string[]): Promise<number> {
  let added = 0;
  for (let i = 0; i < n; i++) {
    const pubkey = `synthetic:${i}`;
    // Idempotent: only seed an attestation+edges for a producer we actually inserted.
    // A `returning` row appears only on first insert; on re-seed the producer exists -> skip,
    // so repeated calls never create orphan/duplicate synthetic attestations.
    const ins = await db.execute<{ pubkey: string }>(
      sql`insert into producers(pubkey, attest_count) values (${pubkey}, 1) on conflict (pubkey) do nothing returning pubkey`);
    if (ins.rows.length === 0) continue;
    added++;
    const aid = randomUUID();
    await db.execute(sql`
      insert into attestations(id, gem_name, gem_digest, producer_pubkey, harness_id, models, scan_sessions, scan_span_days, signal_digest)
      values (${aid},'synthetic',${`synthetic:${i}`},${pubkey},'claude-code','{}',1,1,'synthetic')`);
    for (const id of ids) {
      await db.execute(sql`insert into ingredients(id, kind, id_kind) values (${id},'skill','plugin') on conflict (id) do nothing`);
      await db.execute(sql`insert into usage_edges(attestation_id, ingredient_id, invocations, sessions) values (${aid},${id},1,1)`);
    }
  }
  return added;
}
