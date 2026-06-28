// src/aggregator/__tests__/aggregates.test.ts
import { describe, it, expect } from "vitest";
import { makeTestDb } from "../testDb.js";
import { projectAttestation } from "../project.js";
import { popularity, coOccurrence, DEFAULT_K } from "../aggregates.js";

function att(pubkey: string, digest: string, skills: string[]) {
  return { formatVersion: 1, canonicalizerVersion: 3, gem: { name: "g", digest },
    producer: { publicKey: pubkey, account: null },
    source: { harness: { id: "claude-code" }, models: [], scan: { sessions: 2, spanDays: 1, firstMs: 0, lastMs: 0 } },
    ingredients: { skills: skills.map((id) => ({ id, idKind: "plugin", public: true, invocations: 2, sessions: 1 })), mcps: [] },
    evidence: { signalDigest: "d" }, signedAt: 1, signature: "x" } as never;
}

describe("aggregates + k-anon", () => {
  it("popularity counts distinct producers and enforces k-anon in SQL", async () => {
    const db = await makeTestDb();
    await projectAttestation(db, att("ed25519:p1", "d1", ["skill:a", "skill:b"]));
    await projectAttestation(db, att("ed25519:p2", "d2", ["skill:a"]));
    await projectAttestation(db, att("ed25519:p3", "d3", ["skill:a"]));
    // skill:a used by 3 producers; skill:b by 1
    const k2 = await popularity(db, { kind: "skill", k: 2 });
    expect(k2.map((r) => r.id)).toEqual(["skill:a"]);          // skill:b suppressed at K=2
    expect(k2[0].producers).toBe(3);
    const k1 = await popularity(db, { kind: "skill", k: 1 });
    expect(k1.map((r) => r.id).sort()).toEqual(["skill:a", "skill:b"]);
    // SAFE DEFAULT: omitting k applies DEFAULT_K (>=5), so 3-producer skill:a is suppressed —
    // a forgetful caller never gets un-anonymized rows.
    expect(DEFAULT_K).toBeGreaterThanOrEqual(5);
    expect(await popularity(db, { kind: "skill" })).toEqual([]); // 3 producers < DEFAULT_K
  });
  it("coOccurrence finds partners sharing a producer, k-anon enforced", async () => {
    const db = await makeTestDb();
    await projectAttestation(db, att("ed25519:p1", "d1", ["skill:a", "skill:x"]));
    await projectAttestation(db, att("ed25519:p2", "d2", ["skill:a", "skill:x"]));
    const co = await coOccurrence(db, { id: "skill:a", k: 2 });
    expect(co.map((r) => r.id)).toContain("skill:x");
    expect(co.find((r) => r.id === "skill:x")!.producers).toBe(2);
    // k-anon suppression on the coOccurrence query: a partner used by only 1 producer is hidden at K=2.
    await projectAttestation(db, att("ed25519:p3", "d3", ["skill:a", "skill:y"])); // skill:y: only 1 producer
    const co2 = await coOccurrence(db, { id: "skill:a", k: 2 });
    expect(co2.map((r) => r.id)).toContain("skill:x");     // 2 producers -> visible
    expect(co2.map((r) => r.id)).not.toContain("skill:y"); // 1 producer -> suppressed at K=2 (k-anon in SQL)
  });
});
