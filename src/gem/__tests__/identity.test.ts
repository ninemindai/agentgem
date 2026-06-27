// src/gem/__tests__/identity.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, chmodSync, statSync } from "node:fs";
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

  it("verify returns false (no throw) on malformed key after the prefix", () => {
    expect(verify("ed25519:!!!not-base64-DER!!!", "data", "c2ln")).toBe(false);
    expect(verify("not-a-key", "data", "c2ln")).toBe(false);
  });

  it("re-tightens group/world permissions on existing key file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-id-perm-"));
    const file = join(dir, "identity.json");
    const id1 = loadOrCreateIdentity(dir);
    chmodSync(file, 0o644);
    const id2 = loadOrCreateIdentity(dir);
    expect(statSync(file).mode & 0o077).toBe(0);
    expect(id2.publicKey).toBe(id1.publicKey);
  });
});
