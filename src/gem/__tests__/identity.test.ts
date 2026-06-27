// src/gem/__tests__/identity.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, chmodSync, statSync, renameSync, symlinkSync } from "node:fs";
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

  it("rejects key file that is a symlink (TOCTOU guard via O_NOFOLLOW)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-id-sym-"));
    const file = join(dir, "identity.json");
    const realFile = join(dir, "identity.json.real");
    // Create identity (creates the key file at `file`)
    loadOrCreateIdentity(dir);
    // Move the real file aside and replace it with a symlink pointing to it
    renameSync(file, realFile);
    try {
      symlinkSync(realFile, file);
    } catch {
      // Symlink creation not permitted in this test environment; skip.
      return;
    }
    // loadOrCreateIdentity must refuse to follow the symlink
    expect(() => loadOrCreateIdentity(dir)).toThrow();
  });
});
