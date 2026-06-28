// src/aggregator/__tests__/detection.test.ts
import { describe, it, expect } from "vitest";
import { makeTestDb } from "../testDb.js";
import { projectAttestation } from "../project.js";
import { popularity } from "../aggregates.js";
import { sweepQuarantine } from "../detection.js";

function att(pk: string, digest: string, skills: string[]) {
  return { formatVersion: 1, canonicalizerVersion: 3, gem: { name: "g", digest },
    producer: { publicKey: pk, account: null },
    source: { harness: { id: "claude-code" }, models: [], scan: { sessions: 2, spanDays: 1, firstMs: 0, lastMs: 0 } },
    ingredients: { skills: skills.map((id) => ({ id, idKind: "plugin", public: true, invocations: 2, sessions: 1 })), mcps: [] },
    evidence: { signalDigest: "d:" + digest }, signedAt: 1, signature: "x" } as never;
}
// Lowered thresholds so fixtures stay small; production defaults are higher.
const OPTS = { minProducers: 3, minShape: 2, freshMaxAttest: 1, freshFraction: 0.8 };

describe("sweepQuarantine (detection -> quarantine)", () => {
  it("quarantines a coordinated cluster (fresh keys, identical specific shape) and drops it from aggregates", async () => {
    const db = await makeTestDb();
    const shape = ["skill:a", "skill:b"];
    for (const i of [1, 2, 3]) await projectAttestation(db, att(`ed25519:f${i}`, `d${i}`, shape)); // 3 fresh producers (attest_count=1)
    expect((await popularity(db, { kind: "skill", k: 3 })).map((r) => r.id)).toContain("skill:a"); // visible pre-sweep
    const rep = await sweepQuarantine(db, OPTS);
    expect(rep).toEqual({ clustersFound: 1, attestationsQuarantined: 3, producersFlagged: 3 });
    expect((await popularity(db, { kind: "skill", k: 1 })).map((r) => r.id)).not.toContain("skill:a"); // excluded post-sweep
  });

  it("exempts an organic small shape (below specificity S)", async () => {
    const db = await makeTestDb();
    for (const i of [1, 2, 3]) await projectAttestation(db, att(`ed25519:g${i}`, `e${i}`, ["skill:solo"])); // shape size 1 < minShape 2
    expect((await sweepQuarantine(db, OPTS)).attestationsQuarantined).toBe(0);
    expect((await popularity(db, { kind: "skill", k: 3 })).map((r) => r.id)).toContain("skill:solo");
  });

  it("exempts established producers (below freshness F)", async () => {
    const db = await makeTestDb();
    const shape = ["skill:a", "skill:b"];
    for (const i of [1, 2, 3]) {
      await projectAttestation(db, att(`ed25519:h${i}`, `x${i}`, shape));        // attest #1
      await projectAttestation(db, att(`ed25519:h${i}`, `y${i}`, ["skill:z"]));  // attest #2 -> attest_count=2 (> freshMax 1)
    }
    expect((await sweepQuarantine(db, OPTS)).attestationsQuarantined).toBe(0);
  });

  it("exempts a cluster below the producer threshold", async () => {
    const db = await makeTestDb();
    const shape = ["skill:a", "skill:b"];
    for (const i of [1, 2]) await projectAttestation(db, att(`ed25519:j${i}`, `q${i}`, shape)); // 2 < minProducers 3
    expect((await sweepQuarantine(db, OPTS)).attestationsQuarantined).toBe(0);
  });

  // KNOWN GAP (documented, not yet fixed): the freshness guard keys off `attest_count`, which a
  // sybil can inflate for free. By "warming" each key with one throwaway attestation of an
  // unrelated shape before submitting the coordinated payload, every key crosses freshMax, the
  // cluster's fresh_frac falls below F, and the SAME coordinated shape that IS quarantined when
  // submitted cold escapes entirely. This contrast test pins the asymmetry so a future
  // reputation-based freshness signal (account age / verified org, not attest_count) has a target.
  it("KNOWN GAP: key-warming defeats the freshness guard — same cluster escapes quarantine", async () => {
    const shape = ["skill:a", "skill:b"]; // specific enough to be quarantined cold (>= minShape)

    // Cold: 3 fresh keys, identical specific shape -> quarantined (the attack we DO catch).
    const cold = await makeTestDb();
    for (const i of [1, 2, 3]) await projectAttestation(cold, att(`ed25519:cold${i}`, `c${i}`, shape));
    expect((await sweepQuarantine(cold, OPTS)).attestationsQuarantined).toBe(3);

    // Warmed: the SAME coordinated shape, but each key first submits one throwaway attestation of
    // an unrelated shape, pushing attest_count past freshMax. Cluster now escapes — 0 quarantined.
    const warmed = await makeTestDb();
    for (const i of [1, 2, 3]) {
      await projectAttestation(warmed, att(`ed25519:warm${i}`, `w${i}a`, [`skill:noise${i}`])); // warm-up
      await projectAttestation(warmed, att(`ed25519:warm${i}`, `w${i}b`, shape)); // coordinated payload
    }
    expect((await sweepQuarantine(warmed, OPTS)).attestationsQuarantined).toBe(0); // <-- the bypass
    // And the fabricated shape stays visible in the public aggregate despite being coordinated.
    expect((await popularity(warmed, { kind: "skill", k: 3 })).map((r) => r.id)).toContain("skill:a");
  });

  it("is idempotent", async () => {
    const db = await makeTestDb();
    const shape = ["skill:a", "skill:b", "skill:c"];
    for (const i of [1, 2, 3]) await projectAttestation(db, att(`ed25519:k${i}`, `m${i}`, shape));
    expect((await sweepQuarantine(db, OPTS)).attestationsQuarantined).toBe(3);
    expect(await sweepQuarantine(db, OPTS)).toEqual({ clustersFound: 0, attestationsQuarantined: 0, producersFlagged: 0 });
  });
});
