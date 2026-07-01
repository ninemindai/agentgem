// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { makeTestDb, projectGemAdoption, gemAdoptionCount } from "@agentgem/aggregator";
import { buildGemAdoption, signGemAdoption } from "@agentgem/insight";
import { loadOrCreateIdentity } from "@agentgem/model";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const idOf = (n: string) => loadOrCreateIdentity(mkdtempSync(join(tmpdir(), `ag-${n}-`)));
const ev = (id: ReturnType<typeof idOf>, key = "@alice/kit") =>
  signGemAdoption(buildGemAdoption({ gemKey: key, version: "1.0.0", gemDigest: "sha256:x" }), id, 1);

describe("projectGemAdoption", () => {
  it("counts DISTINCT installers, idempotent per installer", async () => {
    const db = await makeTestDb();
    await projectGemAdoption(db, ev(idOf("a")));
    const second = await projectGemAdoption(db, ev(idOf("b")));
    expect(second.idempotent).toBe(false);
    const alice = idOf("a2");
    await projectGemAdoption(db, ev(alice));
    const again = await projectGemAdoption(db, ev(alice)); // same installer twice
    expect(again.idempotent).toBe(true);
    expect(await gemAdoptionCount(db, "@alice/kit")).toBe(3); // a, b, a2 — the two `alice` rows dedupe
  });
});
