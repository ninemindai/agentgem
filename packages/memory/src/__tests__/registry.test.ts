import { describe, it, expect } from "vitest";
import { getProvider, listProviderIds, IMPLEMENTED } from "../registry.js";
import { NotImplementedError } from "../types.js";

describe("provider registry", () => {
  it("lists all four ids", () => {
    expect(listProviderIds().sort()).toEqual(["letta", "mem0", "supermemory", "zep"]);
  });
  it("mem0 is implemented", () => {
    expect(IMPLEMENTED.has("mem0")).toBe(true);
    expect(getProvider("mem0").id).toBe("mem0");
  });
  it("stub providers reject with NotImplementedError", async () => {
    const zep = getProvider("zep");
    await expect(zep.test({ enabled: true, apiKey: "x" })).rejects.toBeInstanceOf(NotImplementedError);
  });
});
