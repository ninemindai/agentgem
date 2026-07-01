// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/aggregator/__tests__/gemAdoption.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestDb, projectGemAdoption, gemAdoption } from "@agentgem/aggregator";
import { buildGemAdoption, signGemAdoption } from "@agentgem/insight";
import { loadOrCreateIdentity } from "@agentgem/model";
import { AggregatorController } from "../../aggregator.controller.js";

function freshId() {
  return loadOrCreateIdentity(mkdtempSync(join(tmpdir(), "ag-adopt-ga-")));
}

function ev(
  id: ReturnType<typeof freshId>,
  gemKey: string,
  account?: { provider: string; login: string } | null,
) {
  return signGemAdoption(
    buildGemAdoption({ gemKey, version: "1.0.0", gemDigest: "sha256:x", account }),
    id,
    1,
  );
}

describe("gemAdoption aggregate + k-anon", () => {
  it("suppresses a gem with fewer than DEFAULT_K (5) distinct installers", async () => {
    const db = await makeTestDb();
    for (let i = 0; i < 4; i++) {
      await projectGemAdoption(db, ev(freshId(), "@a/g"));
    }
    expect(await gemAdoption(db)).toEqual([]);
  });

  it("returns a row once the 5th installer arrives; verifiedInstalls counts distinct non-null account_login", async () => {
    const db = await makeTestDb();
    // 3 installers without account
    for (let i = 0; i < 3; i++) {
      await projectGemAdoption(db, ev(freshId(), "@a/g"));
    }
    // 4th installer with account "alice"
    await projectGemAdoption(db, ev(freshId(), "@a/g", { provider: "github", login: "alice" }));
    // 5th installer with account "bob"
    await projectGemAdoption(db, ev(freshId(), "@a/g", { provider: "github", login: "bob" }));

    const rows = await gemAdoption(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ gemKey: "@a/g", installs: 5, verifiedInstalls: 2 });
  });

  it("keys filter narrows results to the specified gems only", async () => {
    const db = await makeTestDb();
    for (let i = 0; i < 5; i++) {
      await projectGemAdoption(db, ev(freshId(), "@a/g"));
      await projectGemAdoption(db, ev(freshId(), "@b/h"));
    }
    const all = await gemAdoption(db);
    expect(all.map((r) => r.gemKey).sort()).toEqual(["@a/g", "@b/h"]);

    const filtered = await gemAdoption(db, { keys: ["@a/g"] });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].gemKey).toBe("@a/g");
  });

  it("controller GET /gem-adoption respects k-anon and parses comma-separated keys", async () => {
    const db = await makeTestDb();
    const c = new AggregatorController(db);
    for (let i = 0; i < 5; i++) {
      await projectGemAdoption(db, ev(freshId(), "@a/g"));
    }

    const all = await c.gemAdoption({ query: {} });
    expect(all.items).toHaveLength(1);
    expect(all.items[0].gemKey).toBe("@a/g");

    const filtered = await c.gemAdoption({ query: { keys: "@a/g, @missing/x" } });
    expect(filtered.items.map((i) => i.gemKey)).toContain("@a/g");
    expect(filtered.items.map((i) => i.gemKey)).not.toContain("@missing/x");
  });
});
