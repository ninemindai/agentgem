import { describe, it, expect } from "vitest";
import { parseRef } from "../registry.js";

describe("parseRef", () => {
  it("parses a bare ref as latest", () => {
    expect(parseRef("@acme/github-search")).toEqual({
      key: "@acme/github-search", scope: "acme", name: "github-search", range: "latest",
    });
  });
  it("parses an exact version", () => {
    expect(parseRef("@acme/github-search@1.2.0").range).toBe("1.2.0");
  });
  it("parses a caret range", () => {
    expect(parseRef("@acme/http-base@^1.0.0").range).toBe("^1.0.0");
  });
  it("rejects a ref without a scope", () => {
    expect(() => parseRef("github-search")).toThrow(/scope/i);
  });
  it("rejects illegal characters", () => {
    expect(() => parseRef("@Acme/Foo")).toThrow(/invalid/i);
  });
});
