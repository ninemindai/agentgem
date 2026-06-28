import { describe, it, expect } from "vitest";
import { pages } from "./pages.js";
import { sortedPages } from "./registry.js";

describe("pages registry", () => {
  it("registers ledger + workspaces with unique ids, sortable by order", () => {
    const ordered = sortedPages(pages);
    expect(ordered.map((p) => p.id)).toEqual(["testbed", "ledger", "workspaces", "get-gems", "deploy"]);
  });

  it("every page has a hash route", () => {
    expect(pages.every((p) => p.route.startsWith("#/"))).toBe(true);
  });
});
