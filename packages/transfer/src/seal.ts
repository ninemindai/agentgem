// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

// Length-prefixed, padded plaintext blurs the ciphertext-size signal a broker (or
// anyone watching object sizes) could otherwise read off a transfer. The plaintext
// is framed as: u32 big-endian length || data || zero padding, grown to a quantized
// bucket so many distinct gem sizes map to the same stored size.
const HEADER_LEN = 4; // u32 length prefix
const PAD_FLOOR = 256; // smallest bucket; tiny gems all land here
const PAD_CAP = 1 << 20; // ≤1 MiB → next power of two; above → next whole MiB

// Smallest bucket size that fits `total` bytes.
export function paddedSize(total: number): number {
  if (total <= PAD_CAP) {
    let s = PAD_FLOOR;
    while (s < total) s <<= 1;
    return s;
  }
  return Math.ceil(total / PAD_CAP) * PAD_CAP;
}

function pad(data: Buffer): Buffer {
  const out = Buffer.alloc(paddedSize(HEADER_LEN + data.length)); // zero-filled
  out.writeUInt32BE(data.length, 0);
  data.copy(out, HEADER_LEN);
  return out;
}

function unpad(padded: Buffer): Buffer {
  if (padded.length < HEADER_LEN) throw new Error("seal: corrupt padding (too short)");
  const len = padded.readUInt32BE(0);
  if (HEADER_LEN + len > padded.length) throw new Error("seal: corrupt padding length");
  return padded.subarray(HEADER_LEN, HEADER_LEN + len);
}

export interface Sealed { ciphertext: Buffer; key: Buffer }

// Encrypt under a fresh single-use AES-256-GCM key, over size-padded plaintext.
// Wire format: iv(12) || tag(16) || ciphertext(of padded plaintext)
export function seal(plaintext: Buffer): Sealed {
  const key = randomBytes(KEY_LEN);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(pad(plaintext)), cipher.final()]);
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
  return unpad(Buffer.concat([decipher.update(enc), decipher.final()]));
}
