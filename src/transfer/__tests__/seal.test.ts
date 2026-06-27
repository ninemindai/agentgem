import { describe, it, expect } from "vitest";
import { seal, open } from "../seal.js";

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
});
