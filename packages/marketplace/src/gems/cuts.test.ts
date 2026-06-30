import { describe, it, expect } from "vitest";
import { CUTS, cutMeta } from "./cuts";

describe("cuts", () => {
  it("has the 6 built-in cut ids", () => {
    expect(Object.keys(CUTS).sort()).toEqual(["guide", "integration", "kit", "playbook", "setup", "skill"]);
  });
  it("cutMeta resolves a known cut", () => {
    expect(cutMeta("playbook")?.gemstone).toBe("Pearl");
    expect(cutMeta("integration")?.label).toBe("Integration");
  });
  it("cutMeta returns null for unknown or absent cut", () => {
    expect(cutMeta("bogus")).toBeNull();
    expect(cutMeta(undefined)).toBeNull();
    expect(cutMeta("")).toBeNull();
  });
});
