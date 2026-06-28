// src/aggregator/__tests__/cooccurrenceMatrix.test.ts
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb } from "../testDb.js";
import { projectAttestation } from "../project.js";
import { accountBindings } from "../schema.js";
import { coOccurrenceMatrix } from "../aggregates.js";
import type { AppDb } from "../schema.js";

// Helper: an attestation for `pubkey` carrying the given skill + mcp ids (all public, tools).
function att(pubkey: string, digest: string, skills: string[], mcps: string[] = []) {
  return { formatVersion: 1, canonicalizerVersion: 3, gem: { name: "g", digest },
    producer: { publicKey: pubkey, account: null },
    source: { harness: { id: "claude-code" }, models: ["model:opus-4-8"], scan: { sessions: 2, spanDays: 1, firstMs: 0, lastMs: 0 } },
    ingredients: {
      skills: skills.map((id) => ({ id, idKind: "plugin", public: true, invocations: 2, sessions: 1 })),
      mcps: mcps.map((id) => ({ id, idKind: "plugin", public: true, invocations: 2, sessions: 1 })),
    },
    evidence: { signalDigest: "d" }, signedAt: 1, signature: "x" } as never;
}
async function bind(db: AppDb, pubkey: string, accountId: string) {
  await db.insert(accountBindings).values({ pubkey, provider: "github", accountId, accountLogin: "u" + accountId });
}

describe("coOccurrenceMatrix", () => {
  it("emits each unordered pair once with distinct-producer counts (no dup, no self-pair)", async () => {
    const db = await makeTestDb();
    await projectAttestation(db, att("ed25519:p1", "d1", ["skill:a", "skill:x"]));
    await projectAttestation(db, att("ed25519:p2", "d2", ["skill:a", "skill:x"]));
    const m = await coOccurrenceMatrix(db, { k: 2 });
    // exactly one edge for the pair, lexicographic a<b, no (x,a) duplicate, no (a,a)/(x,x) self-pair
    expect(m).toEqual([{ a: "skill:a", b: "skill:x", producers: 2, verifiedProducers: 0 }]);
  });
  it("suppresses a pair below the k floor and shows it at k=1", async () => {
    const db = await makeTestDb();
    await projectAttestation(db, att("ed25519:p1", "d1", ["skill:a", "skill:x"]));
    await projectAttestation(db, att("ed25519:p2", "d2", ["skill:a", "skill:x"]));
    await projectAttestation(db, att("ed25519:p3", "d3", ["skill:a", "skill:y"])); // (a,y): 1 producer
    expect((await coOccurrenceMatrix(db, { k: 2 })).map((e) => [e.a, e.b])).toEqual([["skill:a", "skill:x"]]);
    const k1 = (await coOccurrenceMatrix(db, { k: 1 })).map((e) => `${e.a}|${e.b}`);
    expect(k1).toContain("skill:a|skill:y"); // visible at k=1
  });
  it("excludes quarantined attestations and counts verified producers separately", async () => {
    const db = await makeTestDb();
    await projectAttestation(db, att("ed25519:p1", "d1", ["skill:a", "skill:x"]));
    await projectAttestation(db, att("ed25519:p2", "d2", ["skill:a", "skill:x"]));
    await bind(db, "ed25519:p1", "100");
    const [edge] = await coOccurrenceMatrix(db, { k: 2 });
    expect(edge).toMatchObject({ a: "skill:a", b: "skill:x", producers: 2, verifiedProducers: 1 });
    await db.execute(sql`update attestations set quarantined = true where producer_pubkey = 'ed25519:p2'`);
    // now only p1 uses the pair -> below k=2 -> suppressed
    expect(await coOccurrenceMatrix(db, { k: 2 })).toEqual([]);
  });
  it("never pairs non-tool kinds (harness/model excluded)", async () => {
    const db = await makeTestDb();
    await projectAttestation(db, att("ed25519:p1", "d1", ["skill:a"], ["mcp:m"]));
    await projectAttestation(db, att("ed25519:p2", "d2", ["skill:a"], ["mcp:m"]));
    const ids = (await coOccurrenceMatrix(db, { k: 2 })).flatMap((e) => [e.a, e.b]);
    // skill:a×mcp:m is a valid tool pair; harness/model ids must never appear
    expect(ids).toContain("skill:a");
    expect(ids).toContain("mcp:m");
    expect(ids.some((i) => i.startsWith("harness") || i.startsWith("model"))).toBe(false);
  });
  it("caps rows by limit, keeping the highest-producer pairs", async () => {
    const db = await makeTestDb();
    // pair (a,x): 3 producers; pair (a,y): 2 producers
    await projectAttestation(db, att("ed25519:p1", "d1", ["skill:a", "skill:x"]));
    await projectAttestation(db, att("ed25519:p2", "d2", ["skill:a", "skill:x"]));
    await projectAttestation(db, att("ed25519:p3", "d3", ["skill:a", "skill:x"]));
    await projectAttestation(db, att("ed25519:p4", "d4", ["skill:a", "skill:y"]));
    await projectAttestation(db, att("ed25519:p5", "d5", ["skill:a", "skill:y"]));
    const top = await coOccurrenceMatrix(db, { k: 2, limit: 1 });
    expect(top).toHaveLength(1);
    expect([top[0].a, top[0].b]).toEqual(["skill:a", "skill:x"]); // 3 producers beats 2
  });
});
