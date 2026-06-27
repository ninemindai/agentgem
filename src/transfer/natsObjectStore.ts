// src/transfer/natsObjectStore.ts
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { Objm, StorageType, type ObjectStore as NatsOS } from "@nats-io/obj";
import { newObjectName, type ObjectStore } from "./objectStore.js";

export interface NatsConfig {
  servers: string;
  bucket?: string;
  token?: string;
  ttlHours?: number; // unclaimed objects expire after this; default DEFAULT_TTL_HOURS
}

export const DEFAULT_TTL_HOURS = 24;

// Hours → NATS Nanos. Stays within Number.MAX_SAFE_INTEGER for any sane TTL
// (24h ≈ 8.6e13 ≪ 9e15). A non-positive TTL means "no expiry" (0 nanos).
export function ttlNanos(hours: number): number {
  if (!(hours > 0)) return 0;
  return Math.round(hours * 3600 * 1_000_000_000);
}

export class NatsObjectStore implements ObjectStore {
  private constructor(
    private nc: NatsConnection,
    private os: NatsOS,
    public readonly bucket: string,
  ) {}

  static async connect(cfg: NatsConfig): Promise<NatsObjectStore> {
    const nc = await connect({ servers: cfg.servers, token: cfg.token });
    const bucket = cfg.bucket ?? "agentgem-transfer";
    const ttl = ttlNanos(cfg.ttlHours ?? DEFAULT_TTL_HOURS);
    try {
      // ttl on the bucket expires unclaimed tickets; burn-after-fetch handles claimed ones.
      // Omit ttl entirely when 0 ("no expiry") — don't pass ttl: 0 to the library.
      const opts = ttl > 0 ? { storage: StorageType.File, ttl } : { storage: StorageType.File };
      const os = await new Objm(nc).create(bucket, opts);
      return new NatsObjectStore(nc, os, bucket);
    } catch (err) {
      await nc.close().catch(() => {}); // best-effort; don't mask the original error
      throw err;
    }
  }

  async put(bytes: Buffer): Promise<string> {
    const name = newObjectName();
    await this.os.putBlob({ name }, bytes);
    return name;
  }

  async get(name: string): Promise<Buffer> {
    const data = await this.os.getBlob(name);
    if (!data) throw new Error(`object not found: ${name}`);
    return Buffer.from(data);
  }

  async del(name: string): Promise<void> {
    await this.os.delete(name);
  }

  async close(): Promise<void> {
    await this.nc.close();
  }
}
