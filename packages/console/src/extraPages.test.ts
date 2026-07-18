import { describe, it, expect } from "vitest";
import { pages } from "./pages.js";
import { corePages } from "./pages.js";
import { extraPages } from "./extraPages.js";

describe("console pages seam", () => {
  it("ships an empty extraPages stub by default", () => {
    expect(extraPages).toEqual([]);
  });

  it("composes pages as corePages followed by extraPages", () => {
    expect(pages).toEqual([...corePages, ...extraPages]);
  });

  it("keeps every core page present in the composed list", () => {
    for (const p of corePages) expect(pages).toContain(p);
  });
});
