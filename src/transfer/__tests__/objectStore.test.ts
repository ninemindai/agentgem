import { describe, it, expect } from "vitest";
import { InMemoryObjectStore } from "@agentgem/transfer";

describe("InMemoryObjectStore", () => {
  it("put returns an unguessable name; get returns the bytes", async () => {
    const os = new InMemoryObjectStore();
    const name = await os.put(Buffer.from("data"));
    expect(name).toMatch(/^[0-9a-f]{32}$/);
    expect(await os.get(name)).toEqual(Buffer.from("data"));
  });
  it("get after del fails (burn)", async () => {
    const os = new InMemoryObjectStore();
    const name = await os.put(Buffer.from("data"));
    await os.del(name);
    await expect(os.get(name)).rejects.toThrow(/not found/);
  });
});
