// src/aggregator/__tests__/verifiedProducers.test.ts
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb } from "@agentgem/aggregator";
import { projectAttestation } from "@agentgem/aggregator";
import { accountBindings } from "@agentgem/aggregator";
import { popularity, coOccurrence, adoption } from "@agentgem/aggregator";
import type { AppDb } from "@agentgem/aggregator";

function att(pubkey: string, digest: string, skills: string[]) {
  return { formatVersion: 1, canonicalizerVersion: 3, gem: { name: "g", digest },
    producer: { publicKey: pubkey, account: null },
    source: { harness: { id: "claude-code" }, models: [], scan: { sessions: 2, spanDays: 1, firstMs: 0, lastMs: 0 } },
    ingredients: { skills: skills.map((id) => ({ id, idKind: "plugin", public: true, invocations: 2, sessions: 1 })), mcps: [] },
    evidence: { signalDigest: "d" }, signedAt: 1, signature: "x" } as never;
}
async function bind(db: AppDb, pubkey: string, accountId: string) {
  await db.insert(accountBindings).values({ pubkey, provider: "github", accountId, accountLogin: "u" + accountId });
}

describe("verifiedProducers overlay", () => {
  it("popularity: two keys on one account collapse to 1 verified; unbound counts raw-only", async () => {
    const db = await makeTestDb();
    await projectAttestation(db, att("ed25519:p1", "d1", ["skill:a"]));
    await projectAttestation(db, att("ed25519:p2", "d2", ["skill:a"]));
    await projectAttestation(db, att("ed25519:p3", "d3", ["skill:a"])); // unbound
    await bind(db, "ed25519:p1", "100");
    await bind(db, "ed25519:p2", "100"); // same account as p1
    const [row] = await popularity(db, { kind: "skill", k: 1 });
    expect(row.producers).toBe(3);           // raw distinct keys
    expect(row.verifiedProducers).toBe(1);   // p1+p2 -> one account; p3 unbound -> not counted
  });
  it("coOccurrence and adoption expose verifiedProducers", async () => {
    const db = await makeTestDb();
    await projectAttestation(db, att("ed25519:p1", "d1", ["skill:a", "skill:x"]));
    await projectAttestation(db, att("ed25519:p2", "d2", ["skill:a", "skill:x"]));
    await bind(db, "ed25519:p1", "100");
    await bind(db, "ed25519:p2", "100");
    const co = await coOccurrence(db, { id: "skill:a", k: 1 });
    const x = co.find((r) => r.id === "skill:x")!;
    expect(x.producers).toBe(2);
    expect(x.verifiedProducers).toBe(1);
    const ad = await adoption(db, { id: "skill:a", k: 1 });
    expect(ad[0].producers).toBe(2);
    expect(ad[0].verifiedProducers).toBe(1);
  });
  it("excludes quarantined attestations from both counts", async () => {
    const db = await makeTestDb();
    await projectAttestation(db, att("ed25519:p1", "d1", ["skill:a"]));
    await bind(db, "ed25519:p1", "100");
    // quarantine the only attestation -> skill:a disappears from aggregates entirely
    await db.execute(sql`update attestations set quarantined = true`);
    expect(await popularity(db, { kind: "skill", k: 1 })).toEqual([]);
  });
});
