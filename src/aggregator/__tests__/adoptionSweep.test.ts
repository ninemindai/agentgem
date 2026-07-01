// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/aggregator/__tests__/adoptionSweep.test.ts
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, projectGemAdoption, gemAdoption, sweepAdoptionQuarantine } from "@agentgem/aggregator";
import type { GemAdoption } from "@agentgem/insight";

/** Minimal GemAdoption fixture — projectGemAdoption does not verify signatures. */
function adopt(pk: string, gemKey: string): GemAdoption {
  return {
    formatVersion: 1,
    gemKey,
    version: "1.0.0",
    gemDigest: `sha256:${pk.replace(/[^a-z0-9]/g, "")}${gemKey.replace(/[^a-z0-9]/g, "")}`,
    event: "install",
    producer: { publicKey: pk, account: null },
    signedAt: 0,
    signature: "x",
  } as never;
}

// Use default thresholds (minProducers=10, freshMaxAttest=2, freshFraction=0.8).
// Seeds 10 distinct producers to hit the floor exactly.
const N = 10;
const GEM = "@test/sybil-gem";

describe("sweepAdoptionQuarantine (adoption sybil detection)", () => {
  it("quarantines fresh-unbound adopters of a suspicious gem and drops it from gemAdoption", async () => {
    const db = await makeTestDb();
    for (let i = 1; i <= N; i++) await projectGemAdoption(db, adopt(`ed25519:a${i}`, GEM));

    // Visible before sweep (k=1 for test convenience).
    const before = await gemAdoption(db, { k: 1 });
    expect(before.map((r) => r.gemKey)).toContain(GEM);

    const rep = await sweepAdoptionQuarantine(db);
    expect(rep.gemsFlagged).toBe(1);
    expect(rep.adoptionsQuarantined).toBe(N);
    expect(rep.producersFlagged).toBe(N);
    expect(rep.dryRun).toBe(false);

    // Gem disappears from public aggregate (all adopters quarantined → count=0 < k=1).
    const after = await gemAdoption(db, { k: 1 });
    expect(after.map((r) => r.gemKey)).not.toContain(GEM);
  });

  it("does not quarantine a GitHub-bound producer within a flagged cluster", async () => {
    const db = await makeTestDb();
    for (let i = 1; i <= N; i++) await projectGemAdoption(db, adopt(`ed25519:b${i}`, GEM));
    // Bind b1 — the account_bindings row makes it exempt.
    await db.execute(sql`insert into account_bindings(pubkey, provider, account_id, account_login)
      values ('ed25519:b1', 'github', 'gh-b1', 'user-b1')`);

    const rep = await sweepAdoptionQuarantine(db);
    expect(rep.adoptionsQuarantined).toBe(N - 1); // b1 exempt
    expect(rep.producersFlagged).toBe(N - 1);

    // Verify b1's row is still not quarantined.
    const row = await db.execute<{ quarantined: boolean }>(
      sql`select quarantined from gem_adoptions where producer_pubkey = 'ed25519:b1' and gem_key = ${GEM}`
    );
    expect(row.rows[0]?.quarantined).toBe(false);
  });

  it("does not quarantine an aged (high attest_count) producer even inside a flagged cluster", async () => {
    const db = await makeTestDb();
    for (let i = 1; i <= N; i++) await projectGemAdoption(db, adopt(`ed25519:c${i}`, GEM));
    // Age c1: set attest_count = 5, above freshMaxAttest default of 2.
    await db.execute(sql`update producers set attest_count = 5 where pubkey = 'ed25519:c1'`);

    const rep = await sweepAdoptionQuarantine(db);
    // Cluster still triggers (9/10 = 90% >= 80% fresh); aged producer exempt from targets.
    expect(rep.adoptionsQuarantined).toBe(N - 1);

    const row = await db.execute<{ quarantined: boolean }>(
      sql`select quarantined from gem_adoptions where producer_pubkey = 'ed25519:c1' and gem_key = ${GEM}`
    );
    expect(row.rows[0]?.quarantined).toBe(false);
  });

  it("leaves a small gem (<10 adopters) untouched", async () => {
    const db = await makeTestDb();
    const SMALL_GEM = "@test/small-gem";
    for (let i = 1; i <= 5; i++) await projectGemAdoption(db, adopt(`ed25519:d${i}`, SMALL_GEM));

    const rep = await sweepAdoptionQuarantine(db);
    expect(rep.gemsFlagged).toBe(0);
    expect(rep.adoptionsQuarantined).toBe(0);

    // Gem still visible.
    const items = await gemAdoption(db, { k: 1 });
    expect(items.map((r) => r.gemKey)).toContain(SMALL_GEM);
  });

  it("dry-run reports adoptionsQuarantined>0 but writes nothing", async () => {
    const db = await makeTestDb();
    for (let i = 1; i <= N; i++) await projectGemAdoption(db, adopt(`ed25519:e${i}`, GEM));

    const dry = await sweepAdoptionQuarantine(db, { dryRun: true });
    expect(dry.adoptionsQuarantined).toBeGreaterThan(0);
    expect(dry.dryRun).toBe(true);

    // No rows actually quarantined — gem still visible.
    const items = await gemAdoption(db, { k: 1 });
    expect(items.map((r) => r.gemKey)).toContain(GEM);

    // A real run still finds + quarantines the same set (dry-run was a no-op).
    const real = await sweepAdoptionQuarantine(db, { dryRun: false });
    expect(real.adoptionsQuarantined).toBe(dry.adoptionsQuarantined);
  });

  it("is idempotent — second real run quarantines nothing new", async () => {
    const db = await makeTestDb();
    for (let i = 1; i <= N; i++) await projectGemAdoption(db, adopt(`ed25519:f${i}`, GEM));

    const first = await sweepAdoptionQuarantine(db);
    expect(first.adoptionsQuarantined).toBe(N);

    const second = await sweepAdoptionQuarantine(db);
    expect(second.adoptionsQuarantined).toBe(0);
    expect(second.gemsFlagged).toBe(0);
    expect(second.producersFlagged).toBe(0);
  });
});
