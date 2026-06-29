import { describe, it, expect, afterEach } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb } from "../testDb.js";
import { projectAttestation } from "../project.js";
import { AggregatorController } from "../../aggregator.controller.js";

function att(pk: string, digest: string, skills: string[]) {
  return { formatVersion: 1, canonicalizerVersion: 3, gem: { name: "g", digest },
    producer: { publicKey: pk, account: null },
    source: { harness: { id: "claude-code" }, models: [], scan: { sessions: 2, spanDays: 1, firstMs: 0, lastMs: 0 } },
    ingredients: { skills: skills.map((id) => ({ id, idKind: "plugin", public: true, invocations: 2, sessions: 1 })), mcps: [] },
    evidence: { signalDigest: "d:" + digest }, signedAt: 1, signature: "x" } as never;
}
const OPTS_ENV = { DETECT_MIN_PRODUCERS: "3", DETECT_MIN_SHAPE: "2", DETECT_FRESH_MAX: "1", DETECT_FRESH_FRACTION: "0.8" };

const orig = { ...process.env };
afterEach(() => { process.env = { ...orig }; });

async function seedCluster(db: Awaited<ReturnType<typeof makeTestDb>>) {
  for (const i of [1, 2, 3]) await projectAttestation(db, att(`ed25519:f${i}`, `d${i}`, ["skill:a", "skill:b"]));
}
async function quarantinedCount(db: Awaited<ReturnType<typeof makeTestDb>>): Promise<number> {
  const r = await db.execute<{ n: number }>(sql`select count(*)::int as n from attestations where quarantined`);
  return Number(r.rows[0].n);
}

describe("POST /api/aggregator/sweep", () => {
  it("refuses when AGGREGATOR_ADMIN_TOKEN is unset", async () => {
    delete process.env.AGGREGATOR_ADMIN_TOKEN;
    const db = await makeTestDb();
    const res = await new AggregatorController(db).sweep({ body: { token: "anything", apply: true } });
    expect(res).toEqual({ ok: false, rejected: "sweep-disabled" });
  });

  it("rejects a wrong token", async () => {
    process.env.AGGREGATOR_ADMIN_TOKEN = "s3cret";
    const db = await makeTestDb();
    const res = await new AggregatorController(db).sweep({ body: { token: "nope", apply: true } });
    expect(res).toEqual({ ok: false, rejected: "unauthorized" });
  });

  it("dry-run (apply omitted) reports but changes nothing", async () => {
    process.env = { ...orig, ...OPTS_ENV, AGGREGATOR_ADMIN_TOKEN: "s3cret" };
    const db = await makeTestDb();
    await seedCluster(db);
    const res = await new AggregatorController(db).sweep({ body: { token: "s3cret" } });
    expect(res).toEqual({ ok: true, report: { clustersFound: 1, attestationsQuarantined: 3, producersFlagged: 3, dryRun: true } });
    expect(await quarantinedCount(db)).toBe(0); // nothing actually quarantined
  });

  it("apply:true quarantines", async () => {
    process.env = { ...orig, ...OPTS_ENV, AGGREGATOR_ADMIN_TOKEN: "s3cret" };
    const db = await makeTestDb();
    await seedCluster(db);
    const res = await new AggregatorController(db).sweep({ body: { token: "s3cret", apply: true } });
    expect(res).toEqual({ ok: true, report: { clustersFound: 1, attestationsQuarantined: 3, producersFlagged: 3, dryRun: false } });
    expect(await quarantinedCount(db)).toBe(3);
  });
});
