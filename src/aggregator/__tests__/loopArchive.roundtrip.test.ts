// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { writeGemArchive, readGemArchive, packTar, unpackTar } from "@agentgem/archive";
import { makeTestDb, upsertGemArchive, getGemArchive } from "@agentgem/aggregator";
import type { Gem, LoopSpec } from "@agentgem/model";

// A goal-mode loop with guardrails + params — exercises every optional sub-field the
// tolerant reader restores, through the real hosted transport (tar.gz bytes + Postgres store).
const loop: LoopSpec = {
  mode: "goal",
  goal: { until: "no failing tests remain", check: "llm" },
  guardrails: { approval: "gate", maxRounds: 5, maxSpendUsd: 2 },
  params: { suite: "unit" },
};

const gem: Gem = {
  name: "green-suite",
  createdFrom: "test",
  artifacts: [{ type: "skill", name: "fix", source: "standalone", content: "# Fix" }],
  checks: [],
  requiredSecrets: [],
  loop,
};

describe("loop survives the hosted publish → install round-trip", () => {
  it("packs to tar bytes, stores, fetches, unpacks, and reads the loop back intact", async () => {
    const db = await makeTestDb();
    const { files } = writeGemArchive(gem);
    const bytes = new Uint8Array(packTar(files));
    await upsertGemArchive(db, { gemKey: "@me/green-suite", version: "1.0.0", bytes, digest: "sha256:loop", createdAtMs: 1 });

    const got = await getGemArchive(db, "@me/green-suite", "1.0.0");
    expect(got).not.toBeNull();
    const restored = readGemArchive(unpackTar(Buffer.from(got!.bytes)));
    expect(restored.loop).toEqual(loop);
  });
});
