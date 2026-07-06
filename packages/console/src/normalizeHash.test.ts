import { describe, it, expect } from "vitest";
import { normalizeHash } from "./registry.js";

describe("normalizeHash", () => {
  it("rewrites legacy gem routes to the merged Gems tabs", () => {
    expect(normalizeHash("#/your-gems")).toBe("#/gems");
    expect(normalizeHash("#/received")).toBe("#/gems/received");
    expect(normalizeHash("#/get-gems")).toBe("#/gems/market");
  });

  it("preserves the query string verbatim (Open-in-AgentGem install deep-link)", () => {
    expect(normalizeHash("#/get-gems?install=abc&v=1.2")).toBe("#/gems/market?install=abc&v=1.2");
    expect(normalizeHash("#/get-gems?q=testing")).toBe("#/gems/market?q=testing");
    expect(normalizeHash("#/your-gems?foo=bar")).toBe("#/gems?foo=bar");
  });

  it("is idempotent — already-normalized hashes pass through unchanged (loop guard)", () => {
    expect(normalizeHash("#/gems")).toBe("#/gems");
    expect(normalizeHash("#/gems/market?install=abc")).toBe("#/gems/market?install=abc");
    expect(normalizeHash("#/gems/received")).toBe("#/gems/received");
  });

  it("leaves unknown routes untouched", () => {
    expect(normalizeHash("#/inspect")).toBe("#/inspect");
    expect(normalizeHash("#/inspect/claude/abc")).toBe("#/inspect/claude/abc");
    expect(normalizeHash("")).toBe("");
  });

  it("does not rewrite a route that merely starts with a legacy prefix", () => {
    // #/get-gems-extra is a different route, not #/get-gems
    expect(normalizeHash("#/get-gems-extra")).toBe("#/get-gems-extra");
  });
});
