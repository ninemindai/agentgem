// src/play/__tests__/scaffolds.docTemplate.test.ts
import { describe, it, expect } from "vitest";
import { docTemplate, staticGate } from "@agentgem/play";
import { HOUSE_TOKEN_NAMES } from "@agentgem/model";

describe("docTemplate (blank document starting point)", () => {
  const html = () => docTemplate("My Report", "✦ new");

  it("passes the static gate untouched", () => {
    expect(staticGate(html())).toEqual({ ok: true, failures: [] });
  });

  it("is a SCROLLING document, not a full-window canvas", () => {
    // The whole point vs minimalTemplate: a document scrolls. The stage scrolls; the body is not trapped.
    expect(html()).toContain("overflow:auto");
    expect(html()).not.toContain("<canvas");
  });

  it("binds the shared house-style tokens and carries the game-data seam + GAME-LOGIC markers", () => {
    for (const name of HOUSE_TOKEN_NAMES) expect(`${name}:${html().includes(`${name}:`)}`).toBe(`${name}:true`);
    expect(html()).toContain('getElementById("game-data")');
    expect(html()).toContain("AGENTGEM:GAME-LOGIC");
  });

  it("escapes the title into the document, not raw", () => {
    expect(docTemplate("<script>x</script>", "sub")).not.toContain("<script>x</script>");
  });
});
