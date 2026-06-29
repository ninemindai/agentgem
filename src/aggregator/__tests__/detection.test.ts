// src/aggregator/__tests__/detection.test.ts
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
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
    expect(rep).toEqual({ clustersFound: 1, attestationsQuarantined: 3, producersFlagged: 3, dryRun: false });
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

  it("is idempotent", async () => {
    const db = await makeTestDb();
    const shape = ["skill:a", "skill:b", "skill:c"];
    for (const i of [1, 2, 3]) await projectAttestation(db, att(`ed25519:k${i}`, `m${i}`, shape));
    expect((await sweepQuarantine(db, OPTS)).attestationsQuarantined).toBe(3);
    expect(await sweepQuarantine(db, OPTS)).toEqual({ clustersFound: 0, attestationsQuarantined: 0, producersFlagged: 0, dryRun: false });
  });

  it("dry-run reports what WOULD be quarantined but changes nothing", async () => {
    const db = await makeTestDb();
    const shape = ["skill:a", "skill:b"];
    for (const i of [1, 2, 3]) await projectAttestation(db, att(`ed25519:f${i}`, `d${i}`, shape));
    const dry = await sweepQuarantine(db, { ...OPTS, dryRun: true });
    expect(dry).toEqual({ clustersFound: 1, attestationsQuarantined: 3, producersFlagged: 3, dryRun: true });
    // nothing was quarantined — skill:a is still visible in aggregates
    expect((await popularity(db, { kind: "skill", k: 1 })).map((r) => r.id)).toContain("skill:a");
    // a real run still finds + quarantines the same 3 (proving dry-run was a no-op)
    const real = await sweepQuarantine(db, OPTS);
    expect(real).toEqual({ clustersFound: 1, attestationsQuarantined: 3, producersFlagged: 3, dryRun: false });
  });

  it("never quarantines a GitHub-verified (bound) producer, even inside a flagged cluster", async () => {
    const db = await makeTestDb();
    const shape = ["skill:a", "skill:b"];
    for (const i of [1, 2, 3]) await projectAttestation(db, att(`ed25519:f${i}`, `d${i}`, shape));
    // bind producer f1 (the #28 anti-sybil anchor); the producer row already exists from projectAttestation
    await db.execute(sql`insert into account_bindings(pubkey, provider, account_id, account_login)
      values ('ed25519:f1', 'github', '42', 'octocat')`);
    const rep = await sweepQuarantine(db, OPTS); // apply
    expect(rep.attestationsQuarantined).toBe(2); // f2 + f3 quarantined; f1 exempt
    expect(rep.producersFlagged).toBe(2);
  });

  it("DEFEATS padding evasion: unique junk per attestation no longer splits a coordinated cluster", async () => {
    const db = await makeTestDb();
    const core = ["skill:a", "skill:b"]; // the shared coordinated core (>= minShape)
    // 3 fresh producers, each padding their attestation with a DISTINCT unique junk skill
    for (const i of [1, 2, 3]) {
      await projectAttestation(db, att(`ed25519:p${i}`, `d${i}`, [...core, `skill:junk${i}`]));
    }
    // v1-equivalent (junk retained): every fingerprint differs -> NO cluster -> nothing flagged
    const v1 = await sweepQuarantine(db, { ...OPTS, coreMinProducers: 1, dryRun: true });
    expect(v1.attestationsQuarantined).toBe(0);
    // v2 (default prefilter, junk freq=1 dropped): cores match -> cluster of 3 -> flagged
    const v2 = await sweepQuarantine(db, { ...OPTS, coreMinProducers: 2, dryRun: true });
    expect(v2).toEqual({ clustersFound: 1, attestationsQuarantined: 3, producersFlagged: 3, dryRun: true });
  });

  it("does not merge two distinct cores into one bogus cluster", async () => {
    const db = await makeTestDb();
    for (const i of [1, 2, 3]) await projectAttestation(db, att(`ed25519:a${i}`, `da${i}`, ["skill:a", "skill:b"]));
    for (const i of [1, 2, 3]) await projectAttestation(db, att(`ed25519:c${i}`, `dc${i}`, ["skill:c", "skill:d"]));
    // both cores survive the prefilter (each ingredient used by its 3-producer group), and stay SEPARATE
    const rep = await sweepQuarantine(db, { ...OPTS, coreMinProducers: 2, dryRun: true });
    expect(rep.clustersFound).toBe(2);          // two distinct clusters, not one merged mega-cluster
    expect(rep.attestationsQuarantined).toBe(6);
  });

  it("padded cluster still exempts a GitHub-verified producer (verified-exemption survives the prefilter)", async () => {
    const db = await makeTestDb();
    const core = ["skill:a", "skill:b"];
    for (const i of [1, 2, 3]) await projectAttestation(db, att(`ed25519:p${i}`, `d${i}`, [...core, `skill:junk${i}`]));
    await db.execute(sql`insert into account_bindings(pubkey, provider, account_id, account_login)
      values ('ed25519:p1', 'github', '42', 'octocat')`);
    const rep = await sweepQuarantine(db, { ...OPTS, coreMinProducers: 2 }); // apply (real)
    expect(rep.attestationsQuarantined).toBe(2); // p2 + p3; p1 exempt (bound)
    expect(rep.producersFlagged).toBe(2);
  });
});
