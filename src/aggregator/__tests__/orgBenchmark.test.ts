// src/aggregator/__tests__/orgBenchmark.test.ts
import { describe, it, expect } from "vitest";
import { makeTestDb, projectAttestation, replaceOrgMembers, orgModelBenchmark, orgMemberLogins, orgEffectiveness, orgMemberBreakdown, accountBindings } from "@agentgem/aggregator";
import type { AppDb } from "@agentgem/aggregator";

// A formatVersion-2 attestation carrying a per-model outcome histogram (mirrors modelBenchmark.test.ts's attV2).
function att(pubkey: string, gemDigest: string, model: string, hist: { mostly?: number; partially?: number; not?: number }, gemName = "g") {
  return { formatVersion: 2, canonicalizerVersion: 3, gem: { name: gemName, digest: gemDigest },
    producer: { publicKey: pubkey, account: null },
    source: { harness: { id: "claude-code" }, models: [model], scan: { sessions: 10, spanDays: 1, firstMs: 0, lastMs: 0 },
      outcomeHistogram: [{ model, mostly: hist.mostly ?? 0, partially: hist.partially ?? 0, not: hist.not ?? 0 }] },
    ingredients: { skills: [], mcps: [] },
    evidence: { signalDigest: "sha256:d" }, signedAt: 1, signature: "x" } as never;
}

async function bind(db: AppDb, pubkey: string, login: string) {
  await db.insert(accountBindings).values({ pubkey, provider: "github", accountId: pubkey.slice(-3), accountLogin: login });
}

describe("orgBenchmark", () => {
  it("orgMemberLogins returns the scope's lowercased gh_logins", async () => {
    const db = await makeTestDb();
    await replaceOrgMembers(db, "acme", [{ login: "Alice", role: "admin" }, { login: "bob", role: "member" }]);
    await replaceOrgMembers(db, "other", [{ login: "carol", role: "member" }]);
    expect((await orgMemberLogins(db, "acme")).sort()).toEqual(["alice", "bob"]);
    expect(await orgMemberLogins(db, "ACME")).toEqual(expect.arrayContaining(["alice", "bob"]));
  });

  it("orgModelBenchmark counts only the scope's bound members, no k-floor", async () => {
    const db = await makeTestDb();
    await projectAttestation(db, att("ed25519:m1", "sha256:d1", "claude-opus-4-8", { mostly: 2 }));  // member u1
    await projectAttestation(db, att("ed25519:x1", "sha256:d2", "claude-opus-4-8", { mostly: 5 }));  // NON-member
    await projectAttestation(db, att("ed25519:u2", "sha256:d3", "claude-opus-4-8", { not: 1 }));     // bound but no org
    await bind(db, "ed25519:m1", "u1");
    await bind(db, "ed25519:x1", "u9");
    await bind(db, "ed25519:u2", "u2");
    await replaceOrgMembers(db, "acme", [{ login: "u1", role: "admin" }]); // only u1 is in acme

    const rows = await orgModelBenchmark(db, "acme");
    expect(rows.length).toBe(1);                    // single-producer k-anon floor NOT applied
    expect(rows[0]).toMatchObject({ model: "claude-opus-4-8", mostly: 2, partially: 0, notAchieved: 0, producers: 1 });
    expect(rows[0].mostly).toBe(2);                 // u9's 5 and u2's 1 excluded
    expect(rows[0].successRate).toBe(1);             // 2/(2+0+0)
  });

  it("excludes quarantined attestations", async () => {
    const db = await makeTestDb();
    await projectAttestation(db, att("ed25519:m1", "sha256:d1", "claude-opus-4-8", { mostly: 3 }));
    await bind(db, "ed25519:m1", "u1");
    await replaceOrgMembers(db, "acme", [{ login: "u1", role: "admin" }]);
    const { sql } = await import("drizzle-orm");
    await db.execute(sql`update attestations set quarantined = true`);
    expect(await orgModelBenchmark(db, "acme")).toEqual([]);
  });

  it("orgEffectiveness scores the scope's gems only, no k-floor", async () => {
    const db = await makeTestDb();
    await projectAttestation(db, att("ed25519:m1", "d1", "m", { mostly: 3 }, "gemA"));
    await projectAttestation(db, att("ed25519:x1", "d2", "m", { mostly: 9 }, "gemZ")); // non-member
    await bind(db, "ed25519:m1", "u1"); await bind(db, "ed25519:x1", "u9");
    await replaceOrgMembers(db, "acme", [{ login: "u1", role: "admin" }]);
    const rows = await orgEffectiveness(db, "acme");
    expect(rows.map((r) => r.gemName)).toEqual(["gemA"]);      // gemZ (non-member) excluded
    expect(rows[0].judged).toBe(3);
  });

  it("orgMemberBreakdown groups by member login", async () => {
    const db = await makeTestDb();
    await projectAttestation(db, att("ed25519:m1", "d1", "m", { mostly: 1 }, "gemA"));
    await projectAttestation(db, att("ed25519:m2", "d2", "m", { not: 1 }, "gemB"));
    await bind(db, "ed25519:m1", "u1"); await bind(db, "ed25519:m2", "u2");
    await replaceOrgMembers(db, "acme", [{ login: "u1", role: "admin" }, { login: "u2", role: "member" }]);
    const rows = await orgMemberBreakdown(db, "acme");
    expect(rows.map((r) => r.login).sort()).toEqual(["u1", "u2"]);
    expect(rows.find((r) => r.login === "u1")).toMatchObject({ attestations: 1, gems: 1, mostly: 1 });
  });
});
