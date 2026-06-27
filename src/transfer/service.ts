// src/transfer/service.ts
// Dependency-injected entry points shared by the MCP tools, REST controller, and
// CLI. The transport (an ObjectStore, possibly a remote one we must close) is
// supplied by a factory: production callers use a NATS store from env, while tests
// inject an in-memory store. This keeps one tested core behind every UX surface.
import { sendGemBytes, receiveGem, type SendResult, type ReceiveResult } from "./index.js";
import type { ObjectStore } from "./objectStore.js";
import { NatsObjectStore } from "./natsObjectStore.js";

// An ObjectStore that may be backed by a remote broker — it carries a bucket name
// and a close(). The in-memory store satisfies this with both omitted.
export interface ManagedStore extends ObjectStore {
  bucket?: string;
  close?(): Promise<void>;
}
export type StoreFactory = () => Promise<ManagedStore>;

const DEFAULT_BUCKET = "agentgem-transfer";

function natsServersOrThrow(): string {
  const servers = process.env.NATS_URL;
  if (!servers) throw new Error("transfer is not configured — set NATS_URL (and optionally NATS_TOKEN)");
  return servers;
}

// Fail-fast guard for callers that do expensive work (e.g. building a gem) before
// they'd otherwise reach the store factory. Throws the same "not configured" error.
export function assertConfigured(): void {
  natsServersOrThrow();
}

// The production factory: a NATS-backed store from env. Throws (without opening a
// connection) when NATS_URL is unset, so callers get a clear "not configured".
export function natsStoreFromEnv(): StoreFactory {
  return async () => {
    const servers = natsServersOrThrow();
    return NatsObjectStore.connect({ servers, token: process.env.NATS_TOKEN });
  };
}

// Seal + stash .gem bytes, returning a one-time ticket. Always closes the store.
export async function sendBytes(gemBytes: Buffer, makeStore: StoreFactory): Promise<SendResult> {
  const store = await makeStore();
  try {
    return await sendGemBytes(gemBytes, store, store.bucket ?? DEFAULT_BUCKET);
  } finally {
    await store.close?.();
  }
}

// Redeem a ticket: fetch, decrypt, verify, burn. Always closes the store.
export async function receiveTicket(ticket: string, makeStore: StoreFactory): Promise<ReceiveResult> {
  const store = await makeStore();
  try {
    return await receiveGem(ticket, store);
  } finally {
    await store.close?.();
  }
}
