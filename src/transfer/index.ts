// src/transfer/index.ts
import { exportGem, importGem } from "../gem/share.js";
import type { Gem } from "../gem/types.js";
import { seal, open } from "./seal.js";
import { encodeTicket, parseTicket } from "./ticket.js";
import type { ObjectStore } from "./objectStore.js";

export { InMemoryObjectStore } from "./objectStore.js";
export type { ObjectStore } from "./objectStore.js";

export interface SendResult { ticket: string; object: string }

// Encrypt .gem bytes, stash the ciphertext, mint a ticket. The key only ever
// leaves here inside the ticket fragment (never to the store).
export async function sendGemBytes(gemBytes: Buffer, store: ObjectStore, bucket: string): Promise<SendResult> {
  const { ciphertext, key } = seal(gemBytes);
  const object = await store.put(ciphertext);
  return { ticket: encodeTicket({ bucket, object, key }), object };
}

export interface ReceiveResult {
  gem: Gem;
  meta: ReturnType<typeof importGem>["meta"];
  bytes: Buffer;
}

// Fetch ciphertext, decrypt, verify integrity (importGem throws on tamper),
// then burn-after-fetch.
export async function receiveGem(ticket: string, store: ObjectStore): Promise<ReceiveResult> {
  const { object, key } = parseTicket(ticket);
  const ciphertext = await store.get(object);
  const bytes = open(ciphertext, key);     // throws on wrong key / tampered transport
  const { gem, meta } = importGem(bytes);  // throws on gem.lock mismatch
  await store.del(object);                  // burn-after-fetch (only on success)
  return { gem, meta, bytes };
}

// Convenience: build the .gem from a Gem and send it.
export async function sendGem(gem: Gem, store: ObjectStore, bucket: string, opts: { version?: string } = {}): Promise<SendResult> {
  const { bytes } = exportGem(gem, { version: opts.version });
  return sendGemBytes(bytes, store, bucket);
}
