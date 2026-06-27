import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { seal, open, paddedSize } from "../seal.js";

describe("seal/open", () => {
  it("round-trips plaintext", () => {
    const pt = Buffer.from("hello gem");
    const { ciphertext, key } = seal(pt);
    expect(open(ciphertext, key)).toEqual(pt);
  });
  it("uses a fresh key each call", () => {
    expect(seal(Buffer.from("x")).key).not.toEqual(seal(Buffer.from("x")).key);
  });
  it("fails to open with the wrong key", () => {
    const { ciphertext } = seal(Buffer.from("secret"));
    expect(() => open(ciphertext, Buffer.alloc(32, 7))).toThrow();
  });
  it("rejects tampered ciphertext (GCM tag)", () => {
    const { ciphertext, key } = seal(Buffer.from("secret"));
    ciphertext[ciphertext.length - 1] ^= 0xff;
    expect(() => open(ciphertext, key)).toThrow();
  });
  it("round-trips across sizes spanning padding buckets", () => {
    for (const n of [0, 1, 251, 252, 253, 1000, 4096, 100000]) {
      const pt = randomBytes(n);
      const { ciphertext, key } = seal(pt);
      expect(open(ciphertext, key)).toEqual(pt);
    }
  });
  it("quantizes ciphertext size so different small gems look identical", () => {
    // 10-byte and 50-byte plaintexts both pad to the 256-byte floor bucket.
    const a = seal(randomBytes(10)).ciphertext.length;
    const b = seal(randomBytes(50)).ciphertext.length;
    expect(a).toBe(b);
  });
  it("paddedSize quantizes to power-of-two buckets (floor 256)", () => {
    expect(paddedSize(1)).toBe(256);
    expect(paddedSize(256)).toBe(256);
    expect(paddedSize(257)).toBe(512);
    expect(paddedSize(1025)).toBe(2048);
  });
});
