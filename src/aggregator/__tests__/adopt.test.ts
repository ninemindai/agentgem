// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/aggregator/__tests__/adopt.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestDb } from "@agentgem/aggregator";
import { AggregatorController } from "../../aggregator.controller.js";
import { buildGemAdoption, signGemAdoption } from "@agentgem/insight";
import { loadOrCreateIdentity } from "@agentgem/model";

describe("AggregatorController /adopt", () => {
  it("accepts a validly signed adoption, idempotent on repeat", async () => {
    const db = await makeTestDb();
    const c = new AggregatorController(db);
    const id = loadOrCreateIdentity(mkdtempSync(join(tmpdir(), "adopt-id-")));
    const signed = signGemAdoption(buildGemAdoption({ gemKey: "@test/gem", version: "1.0.0", gemDigest: "sha256:abc" }), id, 1);

    const first = await c.adopt({ body: signed as never });
    expect(first).toEqual({ accepted: true, idempotent: false });

    const second = await c.adopt({ body: signed as never });
    expect(second).toEqual({ accepted: true, idempotent: true });
  });

  it("rejects a tampered adoption (bad signature)", async () => {
    const db = await makeTestDb();
    const c = new AggregatorController(db);
    const id = loadOrCreateIdentity(mkdtempSync(join(tmpdir(), "adopt-id-")));
    const signed = signGemAdoption(buildGemAdoption({ gemKey: "@test/gem", version: "1.0.0", gemDigest: "sha256:abc" }), id, 1);

    const r = await c.adopt({ body: { ...signed, signature: "AAAA" } as never });
    expect(r).toEqual({ accepted: false, rejected: "bad-signature" });
  });
});
