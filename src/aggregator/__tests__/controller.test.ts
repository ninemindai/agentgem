// src/aggregator/__tests__/controller.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestDb } from "../testDb.js";
import { AggregatorController } from "../../aggregator.controller.js";
import { seedSynthetic } from "../seed.js";
import { buildAttestation, signAttestation } from "../../gem/attestation.js";
import { loadOrCreateIdentity } from "../../gem/identity.js";

const gem = { name: "demo", createdFrom: "claude", artifacts: [
  { type: "skill" as const, name: "brainstorming", source: "plugin:superpowers@m", content: "B" } ], checks: [], requiredSecrets: [] };
const signal = { root: "/p", flavor: "claude" as const, sessions: { scanned: 3, firstMs: 0, lastMs: 0, spanDays: 1 },
  artifacts: [{ type: "skill" as const, name: "brainstorming", root: null, invocations: 9, sessionsUsedIn: 3, lastUsedMs: 0, confidence: "high" as const }],
  unresolved: [], coOccurrence: [], shapes: [], notes: [], models: [{ id: "claude-opus-4-8", sessions: 3 }] };

describe("AggregatorController", () => {
  it("ingests a signed attestation and serves k-anon'd popularity; caller cannot lower k", async () => {
    const db = await makeTestDb();
    const c = new AggregatorController(db);
    const id = loadOrCreateIdentity(mkdtempSync(join(tmpdir(), "agg-id-")));
    const att = signAttestation(buildAttestation({ gem, signal, gemDigest: "sha256:c1", salt: "S" }), id, 1);
    const ing = att.ingredients.skills.find((s) => s.public)!.id;

    expect((await c.ingest({ body: att as never })).accepted).toBe(true);
    await seedSynthetic(db, 2, [ing]); // 3 producers total -> clears DEFAULT_K? only if DEFAULT_K<=3; assert below
    // The route applies DEFAULT_K and ignores any caller k: a malicious ?k=1 must NOT surface a 1-producer ingredient.
    const onlyOneProducer = signAttestation(buildAttestation({ gem: { ...gem, artifacts: [{ type: "skill", name: "solo", source: "plugin:x@m", content: "c" }] },
      signal: { ...signal, artifacts: [{ type: "skill", name: "solo", root: null, invocations: 1, sessionsUsedIn: 1, lastUsedMs: 0, confidence: "high" }] } as never, gemDigest: "sha256:solo", salt: "S" }), id, 1);
    await c.ingest({ body: onlyOneProducer as never });
    const soloId = onlyOneProducer.ingredients.skills.find((s) => s.public)!.id;
    const pop = await c.popularity({ query: { k: 1 } as never }); // caller tries k=1
    expect(pop.map((r) => r.id)).not.toContain(soloId); // still floored by DEFAULT_K — caller k ignored
  });

  it("rejects a tampered attestation", async () => {
    const db = await makeTestDb();
    const c = new AggregatorController(db);
    const id = loadOrCreateIdentity(mkdtempSync(join(tmpdir(), "agg-id-")));
    const att = signAttestation(buildAttestation({ gem, signal, gemDigest: "sha256:c2", salt: "S" }), id, 1);
    const r = await c.ingest({ body: { ...att, signature: "AAAA" } as never });
    expect(r).toEqual({ accepted: false, rejected: "bad-signature" });
  });
});
