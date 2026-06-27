// src/transfer/__tests__/transfer.e2e.test.ts
import { describe, it, expect } from "vitest";
import { exportGem } from "../../gem/share.js";
import { InMemoryObjectStore } from "../objectStore.js";
import { sendGemBytes, receiveGem } from "../index.js";
import type { Gem } from "../../gem/types.js";

const demoGem: Gem = {
  name: "github-search",
  createdFrom: "/tmp/.claude",
  checks: [],
  requiredSecrets: [],
  artifacts: [{ type: "skill", name: "search", source: "standalone", content: "# Search\nFind things.\n" }],
};

describe("transfer e2e", () => {
  it("send -> receive round-trips a verified gem", async () => {
    const store = new InMemoryObjectStore();
    const { bytes } = exportGem(demoGem, { version: "1.0.0" });
    const { ticket } = await sendGemBytes(bytes, store, "agentgem-transfer");
    const { gem, meta } = await receiveGem(ticket, store);
    expect(gem).toEqual(demoGem);
    expect(meta).toMatchObject({ name: "github-search", version: "1.0.0" });
  });

  it("burns the object after fetch (second receive fails)", async () => {
    const store = new InMemoryObjectStore();
    const { bytes } = exportGem(demoGem);
    const { ticket } = await sendGemBytes(bytes, store, "b");
    await receiveGem(ticket, store);
    await expect(receiveGem(ticket, store)).rejects.toThrow(/not found/);
  });

  it("rejects a tampered object (GCM tag fails before import)", async () => {
    const store = new InMemoryObjectStore();
    const { bytes } = exportGem(demoGem);
    const { ticket, object } = await sendGemBytes(bytes, store, "b");
    const stored = await store.get(object); // same Buffer ref held by the map
    stored[stored.length - 1] ^= 0xff;       // tamper in place
    await expect(receiveGem(ticket, store)).rejects.toThrow();
  });
});
