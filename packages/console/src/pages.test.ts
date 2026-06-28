import { describe, it, expect } from "vitest";
import { pages } from "./pages.js";
import { sortedPages, groupedPages } from "./registry.js";

describe("pages registry", () => {
  it("registers curate + your-gems with unique ids, sortable by order", () => {
    const ordered = sortedPages(pages);
    expect(ordered.map((p) => p.id)).toEqual(["curate", "settings", "materialize", "your-gems", "insights", "get-gems", "deploy", "received"]);
  });

  it("every page has a hash route", () => {
    expect(pages.every((p) => p.route.startsWith("#/"))).toBe(true);
  });

  it("assigns each page to a sidebar group", () => {
    const g = groupedPages(pages);
    expect(g.build.map((p) => p.id)).toEqual(["curate", "materialize", "deploy"]);
    expect(g.library.map((p) => p.id)).toEqual(["your-gems", "insights", "get-gems", "received"]);
    expect(g.settings.map((p) => p.id)).toEqual(["settings"]);
  });
});
