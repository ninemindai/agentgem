import { randomBytes } from "node:crypto";

export interface ObjectStore {
  put(bytes: Buffer): Promise<string>; // returns the object name
  get(name: string): Promise<Buffer>;  // throws if missing
  del(name: string): Promise<void>;
}

// Random, unguessable object name (32 hex chars).
export function newObjectName(): string {
  return randomBytes(16).toString("hex");
}

// Hermetic backend for tests — no network.
export class InMemoryObjectStore implements ObjectStore {
  private store = new Map<string, Buffer>();
  async put(bytes: Buffer): Promise<string> {
    const name = newObjectName();
    this.store.set(name, bytes);
    return name;
  }
  async get(name: string): Promise<Buffer> {
    const v = this.store.get(name);
    if (!v) throw new Error(`object not found: ${name}`);
    return v;
  }
  async del(name: string): Promise<void> {
    this.store.delete(name);
  }
}
