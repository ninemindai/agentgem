// src/transfer/__tests__/natsObjectStore.integration.test.ts
import { describe, it, expect } from "vitest";
import { NatsObjectStore } from "../natsObjectStore.js";

const URL = process.env.NATS_URL;
const gated = URL ? describe : describe.skip;

gated("NatsObjectStore (integration, needs NATS_URL)", () => {
  it("put/get/del round-trips against a real NATS", async () => {
    const os = await NatsObjectStore.connect({ servers: URL!, bucket: "agentgem-transfer-test", token: process.env.NATS_TOKEN });
    try {
      const name = await os.put(Buffer.from("integration"));
      expect(await os.get(name)).toEqual(Buffer.from("integration"));
      await os.del(name);
      await expect(os.get(name)).rejects.toThrow();
    } finally {
      await os.close();
    }
  });
});
