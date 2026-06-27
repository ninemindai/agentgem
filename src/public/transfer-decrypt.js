// src/public/transfer-decrypt.js
// Client-side decrypt for a redeemed transfer ticket. Native ES module: runs in the
// browser (<script type="module">) and in Node (crypto.subtle) for the parity test.
// Mirrors src/transfer/seal.ts open(): wire = iv(12) || tag(16) || ciphertext, and
// the decrypted plaintext is padded as u32-BE length || data || zeros.
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = 4;

export async function decryptGem(ciphertext, key) {
  const buf = ciphertext instanceof Uint8Array ? ciphertext : new Uint8Array(ciphertext);
  if (buf.length < IV_LEN + TAG_LEN) throw new Error("decryptGem: ciphertext too short");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = buf.subarray(IV_LEN + TAG_LEN);
  // WebCrypto expects the auth tag appended to the ciphertext.
  const data = new Uint8Array(enc.length + tag.length);
  data.set(enc, 0);
  data.set(tag, enc.length);

  const ck = await crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, tagLength: 128 }, ck, data));

  // Strip the u32-BE length-prefixed padding.
  const len = new DataView(plain.buffer, plain.byteOffset, plain.byteLength).getUint32(0, false);
  if (HEADER_LEN + len > plain.length) throw new Error("decryptGem: corrupt padding length");
  return plain.subarray(HEADER_LEN, HEADER_LEN + len);
}
