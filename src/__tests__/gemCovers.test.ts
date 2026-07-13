// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { makeTestDb, upsertGemCover, getGemCover } from "@agentgem/aggregator";

describe("gem_covers storage", () => {
  it("round-trips cover bytes + content type by (gemKey, version)", async () => {
    const db = await makeTestDb();
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    await upsertGemCover(db, { gemKey: "@acme/tetris", version: "1.0.0", bytes, contentType: "image/png", createdAtMs: 5 });
    const got = await getGemCover(db, "@acme/tetris", "1.0.0");
    expect(got?.contentType).toBe("image/png");
    expect(got ? [...got.bytes] : null).toEqual([...bytes]);
    expect(await getGemCover(db, "@acme/tetris", "9.9.9")).toBeNull();
  });

  it("upsert overwrites an existing cover for the same key+version", async () => {
    const db = await makeTestDb();
    await upsertGemCover(db, { gemKey: "@a/b", version: "1", bytes: new Uint8Array([1]), contentType: "image/png", createdAtMs: 1 });
    await upsertGemCover(db, { gemKey: "@a/b", version: "1", bytes: new Uint8Array([2, 2]), contentType: "image/webp", createdAtMs: 2 });
    const got = await getGemCover(db, "@a/b", "1");
    expect(got?.contentType).toBe("image/webp");
    expect(got ? [...got.bytes] : null).toEqual([2, 2]);
  });
});
