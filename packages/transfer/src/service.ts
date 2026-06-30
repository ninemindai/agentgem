// src/transfer/service.ts
// Dependency-injected entry points shared by the MCP tools, REST controller, and
// CLI. The transport (an ObjectStore, possibly a remote one we must close) is
// supplied by a factory: production callers use a NATS store from env, while tests
// inject an in-memory store. This keeps one tested core behind every UX surface.
import { sendGemBytes, receiveGem, type SendResult, type ReceiveResult } from "./transferIndex.js";
import type { ObjectStore } from "./objectStore.js";
import { NatsObjectStore } from "./natsObjectStore.js";
import { mintScopedCreds, type TransferScope } from "./mint.js";
import { loadOrCreateIdentity, type Identity } from "@agentgem/model";
import { InvalidInputError } from "@agentgem/model";

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
  // InvalidInputError (400) so the framework surfaces this actionable message
  // verbatim instead of masking it as a generic 500 "Internal Server Error".
  if (!servers) throw new InvalidInputError("transfer is not configured — set NATS_URL (and optionally NATS_TOKEN)");
  return servers;
}

// Fail-fast guard for callers that do expensive work (e.g. building a gem) before
// they'd otherwise reach the store factory. Throws the same "not configured" error.
export function assertConfigured(): void {
  natsServersOrThrow();
}

// Test seam: when set, the ciphertext relay uses this store factory instead of NATS,
// so it can be tested hermetically without a broker.
let testStoreFactory: StoreFactory | undefined;
export function setStoreFactoryForTests(f: StoreFactory | undefined): void {
  testStoreFactory = f;
}
function activeStoreFactory(): StoreFactory {
  return testStoreFactory ?? natsStoreFromEnv();
}

// Fetch a ciphertext object and burn it. The server handles ciphertext only — the
// decryption key never reaches it (the browser withholds the ticket fragment).
export async function fetchAndBurnCiphertext(object: string, makeStore: StoreFactory = activeStoreFactory()): Promise<Buffer> {
  const store = await makeStore();
  try {
    const bytes = await store.get(object); // throws if missing / already burned
    await store.del(object);               // burn-after-fetch
    return bytes;
  } finally {
    await store.close?.();
  }
}

// Mint scoped, short-lived creds for an untrusted client (the browser web-receiver).
// Separate config path from NATS_URL/NATS_TOKEN. 400 (InvalidInputError) if unset.
export async function mintCredsFromEnv(scope: TransferScope): Promise<{ creds: string; wsUrl: string; expiresAt: number }> {
  const accountSeed = process.env.NATS_ACCOUNT_SEED;
  const wsUrl = process.env.NATS_WS_URL;
  if (!accountSeed || !wsUrl) {
    throw new InvalidInputError("ephemeral tokens are not configured — set NATS_ACCOUNT_SEED and NATS_WS_URL");
  }
  const { creds, expiresAt } = await mintScopedCreds({ accountSeed, scope });
  return { creds, wsUrl, expiresAt };
}

// Parse $NATS_TTL_HOURS. Fail fast on a non-numeric value rather than silently
// falling through to "no expiry" (a misconfigured typo must not disable ticket TTL).
function ttlHoursFromEnv(): number | undefined {
  const raw = process.env.NATS_TTL_HOURS;
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`invalid NATS_TTL_HOURS: ${JSON.stringify(raw)} (expected a number of hours)`);
  return n;
}

// The production factory: a NATS-backed store from env. Throws (without opening a
// connection) when NATS_URL is unset, so callers get a clear "not configured".
export function natsStoreFromEnv(): StoreFactory {
  return async () => {
    const servers = natsServersOrThrow();
    return NatsObjectStore.connect({ servers, token: process.env.NATS_TOKEN, ttlHours: ttlHoursFromEnv() });
  };
}

// Seal + stash .gem bytes, returning a one-time ticket. Always closes the store.
// The server's signing identity, loaded once (not on every request).
let serverIdentity: Identity | undefined;
function getServerIdentity(): Identity {
  return (serverIdentity ??= loadOrCreateIdentity());
}

export async function sendBytes(gemBytes: Buffer, makeStore: StoreFactory): Promise<SendResult> {
  const store = await makeStore();
  try {
    // Sign with the server's local identity so REST/MCP recipients get provenance,
    // matching the CLI send edge.
    return await sendGemBytes(gemBytes, store, store.bucket ?? DEFAULT_BUCKET, { identity: getServerIdentity() });
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
