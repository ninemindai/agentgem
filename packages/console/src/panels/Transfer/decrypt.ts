// Mirrors src/transfer/seal.ts open(): iv(12) || tag(16) || ciphertext, with the
// decrypted plaintext padded as u32-BE length || data || zeros.
const IV_LEN = 12, TAG_LEN = 16, HEADER_LEN = 4;

export async function decryptGem(ciphertext: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  if (ciphertext.length < IV_LEN + TAG_LEN) throw new Error("decryptGem: ciphertext too short");
  const iv = ciphertext.subarray(0, IV_LEN);
  const tag = ciphertext.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = ciphertext.subarray(IV_LEN + TAG_LEN);
  // WebCrypto AES-GCM expects ciphertext || tag (not separated)
  const data = new Uint8Array(enc.length + tag.length);
  data.set(enc, 0);
  data.set(tag, enc.length);
  const ck = await crypto.subtle.importKey("raw", key as BufferSource, { name: "AES-GCM" }, false, ["decrypt"]);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource, tagLength: 128 }, ck, data as BufferSource),
  );
  const len = new DataView(plain.buffer, plain.byteOffset, plain.byteLength).getUint32(0, false);
  if (HEADER_LEN + len > plain.length) throw new Error("decryptGem: corrupt padding length");
  return plain.subarray(HEADER_LEN, HEADER_LEN + len);
}
