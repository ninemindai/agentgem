// src/aggregator/__tests__/modelBenchmark.test.ts
import { describe, it, expect } from "vitest";
import { makeTestDb, projectAttestation, modelBenchmark } from "@agentgem/aggregator";

// A formatVersion-2 attestation carrying a per-model outcome histogram.
function attV2(pubkey: string, gemDigest: string, hist: { model: string; mostly: number; partially: number; not: number }[]) {
  return { formatVersion: 2, canonicalizerVersion: 3, gem: { name: "g", digest: gemDigest },
    producer: { publicKey: pubkey, account: null },
    source: { harness: { id: "claude-code" }, models: ["claude-opus-4-8"], scan: { sessions: 10, spanDays: 1, firstMs: 0, lastMs: 0 },
      outcomeHistogram: hist },
    ingredients: { skills: [], mcps: [] },
    evidence: { signalDigest: "sha256:d" }, signedAt: 1, signature: "x" } as never;
}

describe("modelBenchmark", () => {
  it("aggregates per-model outcomes across producers with success rates", async () => {
    const db = await makeTestDb();
    await projectAttestation(db, attV2("ed25519:p1", "sha256:1", [{ model: "claude-opus-4-8", mostly: 9, partially: 0, not: 1 }]));
    await projectAttestation(db, attV2("ed25519:p2", "sha256:2", [{ model: "claude-opus-4-8", mostly: 8, partially: 1, not: 1 }]));

    const rows = await modelBenchmark(db, { k: 2 });
    const opus = rows.find((r) => r.model === "claude-opus-4-8")!;
    expect(opus).toMatchObject({ mostly: 17, partially: 1, notAchieved: 2, producers: 2 });
  });

  it("enforces the k-anonymity floor (suppresses models below k distinct producers)", async () => {
    const db = await makeTestDb();
    await projectAttestation(db, attV2("ed25519:solo", "sha256:1", [{ model: "claude-opus-4-8", mostly: 5, partially: 0, not: 0 }]));
    expect(await modelBenchmark(db, { k: 5 })).toEqual([]); // 1 producer < k
  });

  it("can scope the benchmark to a single gem digest", async () => {
    const db = await makeTestDb();
    await projectAttestation(db, attV2("ed25519:p1", "sha256:keep", [{ model: "claude-opus-4-8", mostly: 3, partially: 0, not: 0 }]));
    await projectAttestation(db, attV2("ed25519:p2", "sha256:other", [{ model: "claude-opus-4-8", mostly: 0, partially: 0, not: 3 }]));
    const rows = await modelBenchmark(db, { k: 1, gemDigest: "sha256:keep" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ model: "claude-opus-4-8", mostly: 3, notAchieved: 0, producers: 1 });
  });
});
