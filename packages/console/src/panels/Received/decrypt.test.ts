import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { decryptGem } from "./decrypt.js";

// Reuse the SERVER seal() to produce ciphertext, proving byte-parity with @agentgem/transfer's seal.
// Import the source directly (seal.ts is self-contained — node:crypto only) so this test does
// not depend on a prior `tsc -b` build of dist/.
const { seal } = await import(join(process.cwd(), "..", "..", "packages", "transfer", "src", "seal.ts"));

describe("decryptGem (parity with server seal)", () => {
  it("round-trips across sizes incl. a padding boundary", async () => {
    for (const n of [0, 10, 252, 253, 5000]) {
      const pt = randomBytes(n);
      const { ciphertext, key } = seal(pt);
      const out = await decryptGem(new Uint8Array(ciphertext), new Uint8Array(key));
      expect(Buffer.from(out)).toEqual(pt);
    }
  });

  it("rejects a too-short (but auth-valid) ciphertext with a clean error, not a RangeError", async () => {
    const key = new Uint8Array(randomBytes(32));
    const iv = new Uint8Array(randomBytes(12));
    const ck = await crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["encrypt"]);
    const tag = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, tagLength: 128 }, ck, new Uint8Array(0)));
    const wire = new Uint8Array(28); // iv || tag, zero encrypted bytes → 0-byte plaintext
    wire.set(iv, 0);
    wire.set(tag, 12);
    await expect(decryptGem(wire, key)).rejects.toThrow(/too short/);
  });
});
