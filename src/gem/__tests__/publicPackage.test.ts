import { describe, it, expect } from "vitest";
import { firstPackage, isPublicNpm } from "@agentgem/model";

describe("public-npm classifier", () => {
  it("takes the first non-flag arg", () => {
    expect(firstPackage(["-y", "@scope/pkg"])).toBe("@scope/pkg");
    expect(firstPackage(["pkg"])).toBe("pkg");
    expect(firstPackage("nope")).toBeNull();
  });
  it("classifies public vs private/path", () => {
    expect(isPublicNpm("@modelcontextprotocol/server-x")).toBe(true);
    expect(isPublicNpm("some-bare-pkg")).toBe(true);
    expect(isPublicNpm("@private/thing")).toBe(false); // scope not allowlisted
    expect(isPublicNpm("./local")).toBe(false);
    expect(isPublicNpm("/abs/path")).toBe(false);
  });
});
