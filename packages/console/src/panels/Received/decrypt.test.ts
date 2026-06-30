import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { decryptGem } from "./decrypt.js";

// Reuse the SERVER seal() to produce ciphertext, proving byte-parity with src/transfer/seal.ts.
// Import the source directly (seal.ts is self-contained — node:crypto only) so this test does
// not depend on a prior `tsc -b` build of dist/.
const { seal } = await import(join(process.cwd(), "..", "..", "src", "transfer", "seal.ts"));

describe("decryptGem (parity with server seal)", () => {
  it("round-trips across sizes incl. a padding boundary", async () => {
    for (const n of [0, 10, 252, 253, 5000]) {
      const pt = randomBytes(n);
      const { ciphertext, key } = seal(pt);
      const out = await decryptGem(new Uint8Array(ciphertext), new Uint8Array(key));
      expect(Buffer.from(out)).toEqual(pt);
    }
  });
});
