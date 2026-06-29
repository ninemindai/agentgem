import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { makeTestDb } from "../testDb.js";
import { generateKey, issueKey, verifyKey, revokeKey, listKeys } from "../apiKeys.js";

describe("generateKey", () => {
  it("produces an ag_-prefixed plaintext whose hash is its sha256", () => {
    const { plaintext, hash } = generateKey();
    expect(plaintext.startsWith("ag_")).toBe(true);
    expect(hash).toBe(createHash("sha256").update(plaintext).digest("hex"));
  });
  it("is distinct each call", () => {
    expect(generateKey().plaintext).not.toBe(generateKey().plaintext);
  });
});

describe("issueKey + verifyKey", () => {
  it("issues a key, stores only the hash, and verifies the plaintext", async () => {
    const db = await makeTestDb();
    const issued = await issueKey(db, "acme prod");
    expect(issued.plaintext.startsWith("ag_")).toBe(true);
    expect(issued.label).toBe("acme prod");
    const found = await verifyKey(db, issued.plaintext);
    expect(found).toEqual({ id: issued.id, label: "acme prod" });
  });
  it("rejects an unknown key", async () => {
    const db = await makeTestDb();
    expect(await verifyKey(db, "ag_nope")).toBeNull();
  });
});

describe("revokeKey", () => {
  it("revokes so verify returns null, and is idempotent", async () => {
    const db = await makeTestDb();
    const { id, plaintext } = await issueKey(db, "temp");
    expect(await revokeKey(db, id)).toBe(true);
    expect(await verifyKey(db, plaintext)).toBeNull();
    expect(await revokeKey(db, id)).toBe(false); // already revoked
  });
});

describe("listKeys", () => {
  it("lists all keys as metadata only — never the hash", async () => {
    const db = await makeTestDb();
    await issueKey(db, "first");
    await issueKey(db, "second");
    const rows = await listKeys(db);
    // Order-independent: two inserts can share a created_at millisecond, so don't assert order.
    expect(rows.map((r) => r.label).sort()).toEqual(["first", "second"]);
    expect(Object.keys(rows[0]).sort()).toEqual(["createdAt", "id", "label", "revokedAt"]);
  });
});
