// src/play/__tests__/saveRoute.test.ts
import { describe, it, expect } from "vitest";
import { PlaySaveResponseSchema } from "@agentgem/app/schemas";

describe("PlaySaveResponseSchema", () => {
  it("carries prunedNeeds", () => {
    const parsed = PlaySaveResponseSchema.parse({ name: "g", commit: "abc1234", prunedNeeds: ["invoke-agent"] });
    expect(parsed.prunedNeeds).toEqual(["invoke-agent"]);
  });

  it("defaults prunedNeeds to [] so an older server does not crash the client", () => {
    expect(PlaySaveResponseSchema.parse({ name: "g", commit: null }).prunedNeeds).toEqual([]);
  });

  it("rejects a capability outside the union", () => {
    expect(() => PlaySaveResponseSchema.parse({ name: "g", commit: null, prunedNeeds: ["nope"] })).toThrow();
  });
});
