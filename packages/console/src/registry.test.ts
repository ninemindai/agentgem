import { describe, it, expect } from "vitest";
import { phaseGroups, footerPages, sortedPages } from "./registry.js";
import { defineConsolePage } from "./contract.js";
import type { ConsolePage } from "./contract.js";

const page = (over: Partial<ConsolePage> & Pick<ConsolePage, "id">): ConsolePage =>
  defineConsolePage({
    title: over.id,
    order: 10,
    route: `#/${over.id}`,
    component: () => null,
    ...over,
  } as ConsolePage);

describe("phaseGroups", () => {
  it("buckets pages by category in CATEGORY_ORDER, omitting empty categories", () => {
    const pages = [
      page({ id: "insights", phase: "observe", category: "usage", order: 10 }),
      page({ id: "inspect", phase: "observe", category: "setup", order: 10 }),
      page({ id: "watch", phase: "observe", category: "sessions", order: 10 }),
      // no "projects" page → that category is omitted
    ];
    const groups = phaseGroups(pages, "observe");
    // Observe leads with Usage, Configuration (setup) last.
    expect(groups.map((g) => g.category)).toEqual(["usage", "sessions", "setup"]);
  });

  it("sorts pages within a category bucket by order", () => {
    const pages = [
      page({ id: "gems", phase: "build", category: "setup", order: 30 }),
      page({ id: "curate", phase: "build", category: "setup", order: 10 }),
      page({ id: "sources", phase: "build", category: "setup", order: 20 }),
    ];
    const [setup] = phaseGroups(pages, "build");
    expect(setup.pages.map((p) => p.id)).toEqual(["curate", "sources", "gems"]);
  });

  it("only returns pages for the requested phase", () => {
    const pages = [
      page({ id: "inspect", phase: "observe", category: "setup" }),
      page({ id: "curate", phase: "build", category: "setup" }),
    ];
    expect(phaseGroups(pages, "build").flatMap((g) => g.pages.map((p) => p.id))).toEqual(["curate"]);
  });

  it("throws on a phased page missing its category", () => {
    const pages = [page({ id: "x", phase: "observe" })];
    expect(() => phaseGroups(pages, "observe")).toThrow(/category/i);
  });

  it("throws on a categorized page missing its phase", () => {
    const pages = [page({ id: "x", category: "setup" })];
    expect(() => phaseGroups(pages, "observe")).toThrow(/phase/i);
  });

  it("throws on a page with neither phase nor footer (a miswired migration)", () => {
    const pages = [page({ id: "x" })];
    expect(() => phaseGroups(pages, "observe")).toThrow();
  });

  it("keeps the duplicate-id guard", () => {
    const pages = [
      page({ id: "dup", phase: "observe", category: "setup" }),
      page({ id: "dup", phase: "build", category: "setup" }),
    ];
    expect(() => phaseGroups(pages, "observe")).toThrow(/duplicate/i);
  });
});

describe("footerPages", () => {
  it("returns only pages marked footer:true", () => {
    const pages = [
      page({ id: "inspect", phase: "observe", category: "setup" }),
      page({ id: "settings", footer: true }),
    ];
    expect(footerPages(pages).map((p) => p.id)).toEqual(["settings"]);
  });
});

describe("sortedPages", () => {
  it("still rejects duplicate ids", () => {
    const pages = [page({ id: "a", footer: true }), page({ id: "a", footer: true })];
    expect(() => sortedPages(pages)).toThrow(/duplicate/i);
  });
});
