import { describe, it, expect } from "vitest";
import { makeTestDb } from "../../aggregator/testDb.js";
import { ShareController } from "../../share.controller.js";

const counts = { breadth: 14, battleTested: 3, portable: 5 };

describe("ShareController", () => {
  it("creates a certificate and reads it back", async () => {
    const db = await makeTestDb();
    const c = new ShareController(db);
    const { id, url } = await c.create({ body: { kind: "certificate", counts, generatedAtMs: 5 } });
    expect(id).toMatch(/^[A-Za-z0-9]{8,}$/);
    expect(url).toBe(`https://agentgem.ai/share/${id}`);
    const read = await c.read({ query: { id } });
    expect(read).toEqual({ kind: "certificate", counts, generatedAtMs: 5, createdAtMs: read.createdAtMs });
    expect(typeof read.createdAtMs).toBe("number");
  });

  it("rejects negative counts and unknown fields", async () => {
    const db = await makeTestDb();
    const c = new ShareController(db);
    await expect(c.create({ body: { kind: "certificate", counts: { breadth: -1, battleTested: 0, portable: 0 }, generatedAtMs: 1 } as never }))
      .rejects.toThrow();
  });

  it("404s an unknown id", async () => {
    const db = await makeTestDb();
    const c = new ShareController(db);
    await expect(c.read({ query: { id: "nope000000" } })).rejects.toThrow(/not found/i);
  });
});
