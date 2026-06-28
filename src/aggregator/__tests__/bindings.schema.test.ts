// src/aggregator/__tests__/bindings.schema.test.ts
import { describe, it, expect } from "vitest";
import { makeTestDb } from "../testDb.js";
import { producers, accountBindings } from "../schema.js";

describe("account_bindings schema", () => {
  it("stores a binding and reads it back", async () => {
    const db = await makeTestDb();
    await db.insert(producers).values({ pubkey: "ed25519:p1" });
    await db.insert(accountBindings).values({ pubkey: "ed25519:p1", provider: "github", accountId: "42", accountLogin: "octocat" });
    const rows = await db.select().from(accountBindings);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pubkey: "ed25519:p1", provider: "github", accountId: "42", accountLogin: "octocat" });
  });
  it("rejects a binding for a non-existent producer (FK)", async () => {
    const db = await makeTestDb();
    await expect(
      db.insert(accountBindings).values({ pubkey: "ed25519:ghost", provider: "github", accountId: "1", accountLogin: "x" }),
    ).rejects.toThrow();
  });
});
