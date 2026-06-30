// src/aggregator/__tests__/aggregates.test.ts
import { describe, it, expect } from "vitest";
import { makeTestDb } from "@agentgem/aggregator";
import { projectAttestation } from "@agentgem/aggregator";
import { popularity, coOccurrence, overview, DEFAULT_K } from "@agentgem/aggregator";

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
  it("popularity tools-only default: harness excluded, skills included", async () => {
    const db = await makeTestDb();
    // att() always seeds a harness ingredient ("claude-code"); give 3 producers so skills
    // clear k=1 but harness would too if not filtered.
    await projectAttestation(db, att("ed25519:q1", "e1", ["skill:x"]));
    await projectAttestation(db, att("ed25519:q2", "e2", ["skill:x"]));
    await projectAttestation(db, att("ed25519:q3", "e3", ["skill:x"]));
    // No kind → tools-only default: skill:x visible, harness "claude-code" excluded.
    const noKind = await popularity(db, { k: 1 });
    expect(noKind.map((r) => r.id)).toContain("skill:x");
    expect(noKind.map((r) => r.kind)).not.toContain("harness");
    expect(noKind.find((r) => r.id === "claude-code")).toBeUndefined();
    // Explicit kind: "skill" still works as before.
    const skillOnly = await popularity(db, { kind: "skill", k: 1 });
    expect(skillOnly.map((r) => r.id)).toContain("skill:x");
    expect(skillOnly.map((r) => r.kind)).not.toContain("harness");
  });
  it("coOccurrence partners are tools-only: harness/model excluded", async () => {
    const db = await makeTestDb();
    // att() seeds a harness ingredient "claude-code" on every attestation.
    // Give 2 producers so both skill:a and the harness would clear k=2 if unfiltered.
    await projectAttestation(db, att("ed25519:h1", "f1", ["skill:a", "skill:partner"]));
    await projectAttestation(db, att("ed25519:h2", "f2", ["skill:a", "skill:partner"]));
    const co = await coOccurrence(db, { id: "skill:a", k: 2 });
    // skill:partner (a tool) must appear; claude-code (harness) must not.
    expect(co.map((r) => r.id)).toContain("skill:partner");
    expect(co.find((r) => r.id === "claude-code")).toBeUndefined();
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

describe("overview totals", () => {
  it("aggregates distinct ingredients/producers/verified + sums, k-anon safe", async () => {
    const db = await makeTestDb();
    // 5 producers so the network clears DEFAULT_K (>=5); two ingredients
    await projectAttestation(db, att("ed25519:p1", "d1", ["skill:a", "skill:b"]));
    await projectAttestation(db, att("ed25519:p2", "d2", ["skill:a"]));
    await projectAttestation(db, att("ed25519:p3", "d3", ["skill:a"]));
    await projectAttestation(db, att("ed25519:p4", "d4", ["skill:b"]));
    await projectAttestation(db, att("ed25519:p5", "d5", ["skill:b"]));
    const o = await overview(db, {});
    expect(o.ingredients).toBe(2);   // skill:a, skill:b
    expect(o.producers).toBe(5);     // p1..p5 distinct
    expect(o.verifiedProducers).toBe(0); // no account_bindings
    // p1 seeds 2 skills (inv:2+2=4, sess:1+1=2); p2-p5 each seed 1 skill (inv:2, sess:1 each)
    expect(o.invocations).toBe(12); // 4 + 2 + 2 + 2 + 2
    expect(o.sessions).toBe(6);    // 2 + 1 + 1 + 1 + 1
  });

  it("returns all zeros when the whole network is below the k-anon floor", async () => {
    const db = await makeTestDb();
    await projectAttestation(db, att("ed25519:p1", "d1", ["skill:a"]));
    await projectAttestation(db, att("ed25519:p2", "d2", ["skill:a"]));
    const o = await overview(db, {}); // 2 producers < DEFAULT_K
    expect(o).toEqual({ ingredients: 0, producers: 0, verifiedProducers: 0, invocations: 0, sessions: 0 });
  });
});
