// src/aggregator/__tests__/adoption.test.ts
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb } from "../testDb.js";
import { projectAttestation } from "../project.js";
import { adoption } from "../aggregates.js";

function att(pk: string, digest: string, skills: string[]) {
  return { formatVersion: 1, canonicalizerVersion: 3, gem: { name: "g", digest },
    producer: { publicKey: pk, account: null },
    source: { harness: { id: "claude-code" }, models: [], scan: { sessions: 2, spanDays: 1, firstMs: 0, lastMs: 0 } },
    ingredients: { skills: skills.map((id) => ({ id, idKind: "plugin", public: true, invocations: 2, sessions: 1 })), mcps: [] },
    evidence: { signalDigest: "d:" + digest }, signedAt: 1, signature: "x" } as never;
}
async function setBucket(db: Awaited<ReturnType<typeof makeTestDb>>, pk: string, iso: string) {
  await db.execute(sql`update attestations set ingested_at = ${iso}::timestamptz where producer_pubkey = ${pk}`);
}

describe("adoption (over time, k-anon per bucket)", () => {
  it("returns distinct producers per time bucket, k-anon per bucket", async () => {
    const db = await makeTestDb();
    const w1 = ["a1", "a2", "a3"], w2 = ["b1", "b2", "b3", "b4", "b5"]; // 3 in week 1, 5 in week 2
    for (const p of w1) { await projectAttestation(db, att(`ed25519:${p}`, `d-${p}`, ["skill:x"])); await setBucket(db, `ed25519:${p}`, "2026-06-02"); }
    for (const p of w2) { await projectAttestation(db, att(`ed25519:${p}`, `d-${p}`, ["skill:x"])); await setBucket(db, `ed25519:${p}`, "2026-06-16"); }
    const series = await adoption(db, { id: "skill:x", bucket: "week", k: 3 });
    expect(series.length).toBe(2);
    expect(series.map((s) => s.producers)).toEqual([3, 5]); // ordered by bucket
    expect(series[0].bucket < series[1].bucket).toBe(true); // chronological
    const k4 = await adoption(db, { id: "skill:x", bucket: "week", k: 4 });
    expect(k4.map((s) => s.producers)).toEqual([5]); // 3-producer bucket suppressed at k=4
  });

  it("excludes quarantined attestations", async () => {
    const db = await makeTestDb();
    for (const p of ["c1", "c2", "c3"]) { await projectAttestation(db, att(`ed25519:${p}`, `q-${p}`, ["skill:y"])); await setBucket(db, `ed25519:${p}`, "2026-06-02"); }
    await db.execute(sql`update attestations set quarantined = true where producer_pubkey = 'ed25519:c1'`);
    const series = await adoption(db, { id: "skill:y", bucket: "week", k: 2 });
    expect(series[0].producers).toBe(2); // c1 excluded
  });
});
