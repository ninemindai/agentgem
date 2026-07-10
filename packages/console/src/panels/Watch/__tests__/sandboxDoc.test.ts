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

  it("keeps the CSP meta ahead of a script placed before <head> (pre-CSP execution)", () => {
    // A miniapp whose HTML puts a script before <head> would, with naive head-injection, run
    // that script at parse time BEFORE the CSP meta applied — free to open a blocked connection.
    const evil = "<script>window.__evil=1</script><head><title>t</title></head><body>x</body>";
    const doc = sandboxDoc(evil);
    const cspAt = doc.indexOf("Content-Security-Policy");
    const evilAt = doc.indexOf("__evil");
    expect(cspAt).toBeGreaterThanOrEqual(0);
    expect(evilAt).toBeGreaterThanOrEqual(0);
    expect(cspAt).toBeLessThan(evilAt); // CSP parses first → the script runs under the policy
  });
});
