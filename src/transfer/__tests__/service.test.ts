// src/transfer/__tests__/service.test.ts
import { describe, it, expect } from "vitest";
import { exportGem } from "../../gem/share.js";
import { InMemoryObjectStore } from "../objectStore.js";
import { sendBytes, receiveTicket, natsStoreFromEnv } from "../service.js";
import type { Gem } from "../../gem/types.js";

const demoGem: Gem = {
  name: "github-search",
  createdFrom: "/tmp/.claude",
  checks: [],
  requiredSecrets: [],
  artifacts: [{ type: "skill", name: "search", source: "standalone", content: "# Search\nFind things.\n" }],
};

describe("transfer service", () => {
  it("sendBytes -> receiveTicket round-trips via an injected store factory", async () => {
    const store = new InMemoryObjectStore();
    const make = async () => store;
    const { bytes } = exportGem(demoGem, { version: "1.0.0" });
    const { ticket } = await sendBytes(bytes, make);
    const { gem, meta } = await receiveTicket(ticket, make);
    expect(gem).toEqual(demoGem);
    expect(meta).toMatchObject({ name: "github-search", version: "1.0.0" });
  });

  it("closes a managed store after both send and receive", async () => {
    let closes = 0;
    const inner = new InMemoryObjectStore();
    const managed = {
      put: (b: Buffer) => inner.put(b),
      get: (n: string) => inner.get(n),
      del: (n: string) => inner.del(n),
      bucket: "b",
      close: async () => void closes++,
    };
    const make = async () => managed;
    const { bytes } = exportGem(demoGem);
    const { ticket } = await sendBytes(bytes, make);
    expect(closes).toBe(1);
    expect(ticket.startsWith("agentgem://gem/b/")).toBe(true); // store.bucket flows into the ticket
    await receiveTicket(ticket, make);
    expect(closes).toBe(2);
  });

  it("natsStoreFromEnv() throws when NATS_URL is unset (no connection attempted)", async () => {
    const prev = process.env.NATS_URL;
    delete process.env.NATS_URL;
    try {
      await expect(natsStoreFromEnv()()).rejects.toThrow(/NATS_URL|not configured/i);
    } finally {
      if (prev !== undefined) process.env.NATS_URL = prev;
    }
  });
});
