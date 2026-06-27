// src/transfer/natsObjectStore.ts
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { Objm, StorageType, type ObjectStore as NatsOS } from "@nats-io/obj";
import { newObjectName, type ObjectStore } from "./objectStore.js";

export interface NatsConfig {
  servers: string;
  bucket?: string;
  token?: string;
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
    try {
      const os = await new Objm(nc).create(bucket, { storage: StorageType.File });
      return new NatsObjectStore(nc, os, bucket);
    } catch (err) {
      await nc.close();
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
