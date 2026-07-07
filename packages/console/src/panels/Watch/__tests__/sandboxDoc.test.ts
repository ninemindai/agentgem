// packages/console/src/panels/Watch/__tests__/sandboxDoc.test.ts
import { describe, it, expect } from "vitest";
import { sandboxDoc } from "../sandboxDoc.js";

describe("sandboxDoc", () => {
  it("injects the strict CSP and the in-memory storage shim into <head>", () => {
    const doc = sandboxDoc("<html><head></head><body>x</body></html>");
    expect(doc).toContain("Content-Security-Policy");
    expect(doc).toContain("default-src 'none'");
    // storage shim so null-origin games using localStorage don't crash on load
    expect(doc).toContain("localStorage");
    expect(doc).toContain("Object.defineProperty");
    // shim precedes the body so it runs before the game's scripts
    expect(doc.indexOf("localStorage")).toBeLessThan(doc.indexOf("<body"));
  });
  it("wraps head-less html too", () => {
    expect(sandboxDoc("<p>hi</p>")).toContain("<head>");
  });
});
