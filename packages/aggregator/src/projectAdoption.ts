// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { sql } from "drizzle-orm";
import type { AppDb } from "./schema.js";
import { producers, gemAdoptions } from "./schema.js";
import type { GemAdoption } from "@agentgem/insight";

export async function projectGemAdoption(db: AppDb, a: GemAdoption): Promise<{ idempotent: boolean }> {
  // Upsert the producer row — adoption does NOT bump attestCount.
  await db.insert(producers).values({ pubkey: a.producer.publicKey, attestCount: 0 })
    .onConflictDoNothing({ target: producers.pubkey });

  // PGlite-safe idempotency: pre-check before upsert (xmax is unreliable under PGlite).
  const existing = await db.execute(
    sql`select 1 from gem_adoptions where gem_key = ${a.gemKey} and producer_pubkey = ${a.producer.publicKey}`
  );
  const idempotent = existing.rows.length > 0;

  await db.insert(gemAdoptions).values({
    gemKey: a.gemKey,
    gemDigest: a.gemDigest,
    producerPubkey: a.producer.publicKey,
    accountLogin: a.producer.account?.login ?? null,
    event: a.event,
  }).onConflictDoUpdate({
    target: [gemAdoptions.gemKey, gemAdoptions.producerPubkey],
    set: {
      gemDigest: a.gemDigest,
      adoptedAt: sql`now()`,
      accountLogin: a.producer.account?.login ?? null,
    },
  });

  return { idempotent };
}

export async function gemAdoptionCount(db: AppDb, gemKey: string): Promise<number> {
  const r = await db.execute<{ c: number }>(
    sql`select count(distinct producer_pubkey)::int as c from gem_adoptions where gem_key = ${gemKey}`
  );
  return r.rows[0]?.c ?? 0;
}
