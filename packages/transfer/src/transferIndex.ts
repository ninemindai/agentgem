// src/transfer/index.ts
import { exportGem, importGem } from "@agentgem/distribute";
import type { Gem } from "@agentgem/model";
import { verify, type Identity } from "@agentgem/model";
import { seal, open } from "./seal.js";
import { encodeTicket, parseTicket } from "./ticket.js";
import type { ObjectStore } from "./objectStore.js";

export { InMemoryObjectStore } from "./objectStore.js";
export type { ObjectStore } from "./objectStore.js";

export interface SendResult { ticket: string; object: string }
export interface Provenance { signed: boolean; verified: boolean; publicKey?: string }
export interface SendOpts { identity?: Identity | null }

// Encrypt .gem bytes, stash the ciphertext, mint a ticket. Unsigned by default; pass
// an identity (the CLI and the service layer do, via loadOrCreateIdentity) to sign the
// gem digest so the recipient can verify who sent it. Receivers without a producer get
// signed:false. The key + producer live only in the ticket fragment.
export async function sendGemBytes(gemBytes: Buffer, store: ObjectStore, bucket: string, opts: SendOpts = {}): Promise<SendResult> {
  const { ciphertext, key } = seal(gemBytes);
  const object = await store.put(ciphertext);
  const identity = opts.identity ?? null;
  let producer: { publicKey: string; signature: string } | undefined;
  if (identity) {
    const { meta } = importGem(gemBytes); // derive the gem digest (also validates bytes)
    producer = { publicKey: identity.publicKey, signature: identity.sign(meta.gemDigest) };
  }
  return { ticket: encodeTicket({ bucket, object, key, producer }), object };
}

export interface ReceiveResult {
  gem: Gem;
  meta: ReturnType<typeof importGem>["meta"];
  bytes: Buffer;
  provenance: Provenance;
}

// Fetch ciphertext, decrypt, verify integrity (importGem throws on tamper), verify
// the producer signature (additive), then burn-after-fetch.
export async function receiveGem(ticket: string, store: ObjectStore): Promise<ReceiveResult> {
  const { object, key, producer } = parseTicket(ticket);
  const ciphertext = await store.get(object);
  const bytes = open(ciphertext, key);     // throws on wrong key / tampered transport
  const { gem, meta } = importGem(bytes);  // throws on gem.lock mismatch
  await store.del(object);                  // burn-after-fetch (only on success)
  const provenance: Provenance = producer
    ? { signed: true, verified: verify(producer.publicKey, meta.gemDigest, producer.signature), publicKey: producer.publicKey }
    : { signed: false, verified: false };
  return { gem, meta, bytes, provenance };
}

// Convenience: build the .gem from a Gem and send it.
export async function sendGem(gem: Gem, store: ObjectStore, bucket: string, opts: { version?: string } & SendOpts = {}): Promise<SendResult> {
  const { bytes } = exportGem(gem, { version: opts.version });
  return sendGemBytes(bytes, store, bucket, { identity: opts.identity });
}
