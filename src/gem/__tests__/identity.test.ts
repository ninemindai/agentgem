// src/gem/__tests__/identity.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateIdentity, verify } from "../identity.js";

describe("identity", () => {
  it("creates a stable keypair and signs/verifies", () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-id-"));
    const id1 = loadOrCreateIdentity(dir);
    const sig = id1.sign("hello");
    expect(verify(id1.publicKey, "hello", sig)).toBe(true);
    expect(verify(id1.publicKey, "tampered", sig)).toBe(false);
    const id2 = loadOrCreateIdentity(dir); // reloads, does not regenerate
    expect(id2.publicKey).toBe(id1.publicKey);
  });
});
