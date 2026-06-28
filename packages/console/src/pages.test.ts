import { describe, it, expect } from "vitest";
import { pages } from "./pages.js";
import { sortedPages, groupedPages } from "./registry.js";

describe("pages registry", () => {
  it("registers ledger + workspaces with unique ids, sortable by order", () => {
    const ordered = sortedPages(pages);
    expect(ordered.map((p) => p.id)).toEqual(["testbed", "ledger", "materialize", "workspaces", "get-gems", "deploy", "transfer"]);
  });

  it("every page has a hash route", () => {
    expect(pages.every((p) => p.route.startsWith("#/"))).toBe(true);
  });

  it("assigns each page to a sidebar group", () => {
    const g = groupedPages(pages);
    expect(g.build.map((p) => p.id)).toEqual(["testbed", "ledger", "materialize"]);
    expect(g.library.map((p) => p.id)).toEqual(["workspaces", "get-gems", "transfer"]);
    expect(g.settings.map((p) => p.id)).toEqual(["deploy"]);
  });
});
