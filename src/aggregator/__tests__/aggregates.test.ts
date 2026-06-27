// src/aggregator/__tests__/aggregates.test.ts
import { describe, it, expect } from "vitest";
import { createDb } from "../db.js";
import { projectAttestation } from "../project.js";
import { popularity, coOccurrence } from "../aggregates.js";

function att(pubkey: string, digest: string, skills: string[]) {
  return { formatVersion: 1, canonicalizerVersion: 3, gem: { name: "g", digest },
    producer: { publicKey: pubkey, account: null },
    source: { harness: { id: "claude-code" }, models: [], scan: { sessions: 2, spanDays: 1, firstMs: 0, lastMs: 0 } },
    ingredients: { skills: skills.map((id) => ({ id, idKind: "plugin", public: true, invocations: 2, sessions: 1 })), mcps: [] },
    evidence: { signalDigest: "d" }, signedAt: 1, signature: "x" } as never;
}

describe("aggregates + k-anon", () => {
  it("popularity counts distinct producers and enforces k-anon in SQL", async () => {
    const db = await createDb();
    await projectAttestation(db, att("ed25519:p1", "d1", ["skill:a", "skill:b"]));
    await projectAttestation(db, att("ed25519:p2", "d2", ["skill:a"]));
    await projectAttestation(db, att("ed25519:p3", "d3", ["skill:a"]));
    // skill:a used by 3 producers; skill:b by 1
    const k2 = await popularity(db, { kind: "skill", k: 2 });
    expect(k2.map((r) => r.id)).toEqual(["skill:a"]);          // skill:b suppressed at K=2
    expect(k2[0].producers).toBe(3);
    const k1 = await popularity(db, { kind: "skill", k: 1 });
    expect(k1.map((r) => r.id).sort()).toEqual(["skill:a", "skill:b"]);
  });
  it("coOccurrence finds partners sharing a producer, k-anon enforced", async () => {
    const db = await createDb();
    await projectAttestation(db, att("ed25519:p1", "d1", ["skill:a", "skill:x"]));
    await projectAttestation(db, att("ed25519:p2", "d2", ["skill:a", "skill:x"]));
    const co = await coOccurrence(db, { id: "skill:a", k: 2 });
    expect(co.map((r) => r.id)).toContain("skill:x");
    expect(co.find((r) => r.id === "skill:x")!.producers).toBe(2);
  });
});
