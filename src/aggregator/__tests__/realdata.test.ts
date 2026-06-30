// src/aggregator/__tests__/realdata.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestDb } from "@agentgem/aggregator";
import { ingestAttestation } from "@agentgem/aggregator";
import { seedSynthetic } from "@agentgem/aggregator";
import { popularity } from "@agentgem/aggregator";
import { buildAttestation, signAttestation } from "@agentgem/insight";
import { loadOrCreateIdentity } from "@agentgem/model";

const gem = { name: "demo", createdFrom: "claude", artifacts: [
  { type: "skill" as const, name: "brainstorming", source: "plugin:superpowers@claude-plugins-official", content: "B" },
], checks: [], requiredSecrets: [] };
const signal = { root: "/p", flavor: "claude" as const, sessions: { scanned: 3, firstMs: 0, lastMs: 0, spanDays: 1 },
  artifacts: [{ type: "skill" as const, name: "brainstorming", root: null, invocations: 9, sessionsUsedIn: 3, lastUsedMs: 0, confidence: "high" as const }],
  unresolved: [], coOccurrence: [], shapes: [], notes: [], models: [{ id: "claude-opus-4-8", sessions: 3 }] };

describe("seeding + real signed attestation", () => {
  it("a real attestation's public ingredient surfaces in popularity once k-anon is met via seeding", async () => {
    const db = await makeTestDb();
    const id = loadOrCreateIdentity(mkdtempSync(join(tmpdir(), "agg-id-")));
    const att = signAttestation(buildAttestation({ gem, signal, gemDigest: "sha256:real", salt: "S" }), id, 1);
    const ing = att.ingredients.skills.find((s) => s.public)!.id; // e.g. skill:superpowers@.../brainstorming
    expect(ing.startsWith("skill:")).toBe(true);

    const r = await ingestAttestation(db, att);
    expect(r.accepted).toBe(true);
    // with only 1 real producer, k=2 hides it:
    expect((await popularity(db, { kind: "skill", k: 2 })).map((x) => x.id)).not.toContain(ing);
    // seed 2 synthetic producers also using it -> now 3 producers -> visible at k=2:
    await seedSynthetic(db, 2, [ing]);
    expect((await popularity(db, { kind: "skill", k: 2 })).map((x) => x.id)).toContain(ing);
  });
});
