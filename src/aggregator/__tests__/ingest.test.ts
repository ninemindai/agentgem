// src/aggregator/__tests__/ingest.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { makeTestDb } from "@agentgem/aggregator";
import { ingestAttestation } from "@agentgem/aggregator";
import { buildAttestation, signAttestation } from "@agentgem/insight";
import { loadOrCreateIdentity } from "@agentgem/model";

const gem = { name: "demo", createdFrom: "claude", artifacts: [
  { type: "skill" as const, name: "qa", source: "plugin:superpowers@m", content: "B" },
], checks: [], requiredSecrets: [] };
const signal = { root: "/p", flavor: "claude" as const, sessions: { scanned: 4, firstMs: 0, lastMs: 0, spanDays: 1 },
  artifacts: [{ type: "skill" as const, name: "qa", root: null, invocations: 5, sessionsUsedIn: 2, lastUsedMs: 0, confidence: "high" as const }],
  unresolved: [], coOccurrence: [], shapes: [], notes: [], models: [{ id: "claude-opus-4-8", sessions: 4 }] };
function make(digest: string) {
  const id = loadOrCreateIdentity(mkdtempSync(join(tmpdir(), "agg-id-")));
  return signAttestation(buildAttestation({ gem, signal, gemDigest: digest, salt: "S" }), id, 1);
}

describe("ingestAttestation", () => {
  it("accepts, projects, and is idempotent on gem_digest", async () => {
    const db = await makeTestDb();
    const a = make("sha256:unique1");
    const r1 = await ingestAttestation(db, a);
    expect(r1.accepted).toBe(true);
    const r2 = await ingestAttestation(db, a); // re-POST same record
    expect(r2).toMatchObject({ accepted: true, idempotent: true });
    const n = (await db.execute<{ c: number }>(sql`select count(*)::int as c from attestations`)).rows[0].c;
    expect(n).toBe(1); // no duplicate
  });
  it("rejects a tampered signature without writing", async () => {
    const db = await makeTestDb();
    const r = await ingestAttestation(db, { ...make("sha256:u2"), signature: "AAAA" });
    expect(r).toEqual({ accepted: false, rejected: "bad-signature" });
    expect((await db.execute<{ c: number }>(sql`select count(*)::int as c from attestations`)).rows[0].c).toBe(0);
  });
});
