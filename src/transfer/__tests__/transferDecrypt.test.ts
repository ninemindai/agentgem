// src/transfer/__tests__/transferDecrypt.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { seal } from "@agentgem/transfer";

// The browser module is plain ESM JS — import it directly from source (no dist/copy needed).
let decryptGem: (c: Uint8Array, k: Uint8Array) => Promise<Uint8Array>;
beforeAll(async () => {
  ({ decryptGem } = await import(join(process.cwd(), "src/public/transfer-decrypt.js")));
});

describe("decryptGem (browser parity with seal.open)", () => {
  it("round-trips seal() output across sizes incl. a padding boundary", async () => {
    // 252 -> 256-byte bucket, 253 -> 512-byte bucket: straddles a real padding edge.
    for (const n of [0, 10, 252, 253, 256, 5000]) {
      const pt = randomBytes(n);
      const { ciphertext, key } = seal(pt);
      const out = await decryptGem(new Uint8Array(ciphertext), new Uint8Array(key));
      expect(Buffer.from(out)).toEqual(pt);
    }
  });
  it("rejects a wrong key", async () => {
    const { ciphertext } = seal(Buffer.from("secret"));
    await expect(decryptGem(new Uint8Array(ciphertext), new Uint8Array(32))).rejects.toThrow();
  });

  it("rejects a too-short (but auth-valid) ciphertext with a clean error, not a RangeError", async () => {
    // A hand-crafted 28-byte wire (iv || tag, zero encrypted bytes) authenticates and decrypts to a
    // 0-byte plaintext — then getUint32(0) on the empty buffer threw a raw RangeError. seal() always
    // pads past this, but a corrupt/adversarial ticket can hit it.
    const key = new Uint8Array(randomBytes(32));
    const iv = new Uint8Array(randomBytes(12));
    const ck = await crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["encrypt"]);
    const tag = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, tagLength: 128 }, ck, new Uint8Array(0)));
    const wire = new Uint8Array(28);
    wire.set(iv, 0);
    wire.set(tag, 12);
    await expect(decryptGem(wire, key)).rejects.toThrow(/too short/);
  });
});
