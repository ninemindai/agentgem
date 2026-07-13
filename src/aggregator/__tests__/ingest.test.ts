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

const fixedId = loadOrCreateIdentity(mkdtempSync(join(tmpdir(), "agg-fixed-")));
const makeFixed = (digest: string, invocations: number) => signAttestation(
  buildAttestation({ gem, signal: { ...signal, artifacts: [{ ...signal.artifacts[0], invocations, sessionsUsedIn: 2 }] }, gemDigest: digest, salt: "S" }), fixedId, 1);

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
  it("keeps a per-producer record: two producers of the same gem digest are both stored", async () => {
    const db = await makeTestDb();
    const p1 = make("sha256:shared"); // producer A
    const p2 = make("sha256:shared"); // producer B — SAME digest, different key
    expect(await ingestAttestation(db, p1)).toMatchObject({ accepted: true, idempotent: false });
    // Before the re-key this was deduped away (idempotent: true) and B's data + producer row vanished.
    expect(await ingestAttestation(db, p2)).toMatchObject({ accepted: true, idempotent: false });
    expect((await db.execute<{ c: number }>(sql`select count(*)::int as c from attestations`)).rows[0].c).toBe(2);
    expect((await db.execute<{ c: number }>(sql`select count(*)::int as c from producers`)).rows[0].c).toBe(2); // B is now visible
  });

  it("rejects a tampered signature without writing", async () => {
    const db = await makeTestDb();
    const r = await ingestAttestation(db, { ...make("sha256:u2"), signature: "AAAA" });
    expect(r).toEqual({ accepted: false, rejected: "bad-signature" });
    expect((await db.execute<{ c: number }>(sql`select count(*)::int as c from attestations`)).rows[0].c).toBe(0);
  });

  it("resubmit refreshes usage in place without new rows, count bumps, or ingested_at churn", async () => {
    const db = await makeTestDb();
    const r1 = await ingestAttestation(db, makeFixed("sha256:re", 5));
    expect(r1).toMatchObject({ accepted: true, idempotent: false, updated: false });
    const before = (await db.execute<{ t: string }>(sql`select ingested_at::text as t from attestations`)).rows[0].t;
    const r2 = await ingestAttestation(db, makeFixed("sha256:re", 9));
    expect(r2).toMatchObject({ accepted: true, idempotent: true, updated: true });
    expect((await db.execute<{ c: number }>(sql`select count(*)::int c from attestations`)).rows[0].c).toBe(1);
    expect((await db.execute<{ c: number }>(sql`select attest_count c from producers`)).rows[0].c).toBe(1);
    const after = (await db.execute<{ t: string }>(sql`select ingested_at::text t from attestations`)).rows[0].t;
    expect(after).toBe(before); // #4: ingested_at preserved
    expect((await db.execute<{ c: number }>(sql`select invocations c from usage_edges where invocations = 9`)).rows.length).toBe(1);
  });
});
