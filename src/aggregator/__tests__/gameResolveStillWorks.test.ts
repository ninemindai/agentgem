// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { makeTestDb, upsertGemArchive, archiveOnlyVersion, getGemArchive } from "@agentgem/aggregator";

describe("archive-only /games/<id> resolve survives the quick-share retirement", () => {
  it("resolves an existing archive-only row by its slash-less share id", async () => {
    const db = await makeTestDb();
    const bytes = new Uint8Array([1, 2, 3]);
    await upsertGemArchive(db, { gemKey: "abc123", version: "1", bytes, digest: "d", createdAtMs: 1 });
    // no catalog_gems row => archive-only => resolvable by share id
    expect(await archiveOnlyVersion(db, "abc123")).toBe("1");
    const a = await getGemArchive(db, "abc123", "1");
    expect(a?.digest).toBe("d");
  });
});
