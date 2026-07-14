import { describe, it, expect } from "vitest";
import { NotImplementedError, type ProviderId } from "../types.js";

describe("memory types", () => {
  it("NotImplementedError carries the provider id", () => {
    const err = new NotImplementedError("zep");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("zep");
    expect(err.providerId).toBe("zep");
  });

  it("ProviderId is a closed set (compile-time) — sanity at runtime", () => {
    const ids: ProviderId[] = ["mem0", "supermemory", "zep", "letta"];
    expect(ids).toHaveLength(4);
  });
});
