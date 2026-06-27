// src/transfer/__tests__/transferDecrypt.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { seal } from "../seal.js";

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
});
