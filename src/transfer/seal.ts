import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

export interface Sealed { ciphertext: Buffer; key: Buffer }

// Encrypt under a fresh single-use AES-256-GCM key.
// Wire format: iv(12) || tag(16) || ciphertext
export function seal(plaintext: Buffer): Sealed {
  const key = randomBytes(KEY_LEN);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext: Buffer.concat([iv, cipher.getAuthTag(), enc]), key };
}

// Decrypt; throws if key is wrong or ciphertext was tampered (GCM tag fails).
export function open(ciphertext: Buffer, key: Buffer): Buffer {
  if (key.length !== KEY_LEN) throw new Error("seal: key must be 32 bytes");
  const iv = ciphertext.subarray(0, IV_LEN);
  const tag = ciphertext.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = ciphertext.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}
