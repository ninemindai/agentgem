import { describe, it, expect } from "vitest";
import { phaseGroups, footerPages, sortedPages, normalizeHash, railModel } from "./registry.js";
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

describe("railModel", () => {
  const synthetic = [
    // foreground: no group, no footer (phase/category still set, same as the real registry)
    page({ id: "overview", order: 5, phase: "observe", category: "usage" }),
    page({ id: "curate", order: 10, phase: "build", category: "setup" }),
    page({ id: "materialize", order: 10, phase: "build", category: "projects", group: "observe", hiddenUntilUnlock: true }),
    page({ id: "benchmark", order: 20, phase: "observe", category: "usage", group: "build", hiddenUntilUnlock: true }),
    page({ id: "mine", order: 10, phase: "observe", category: "projects", group: "evaluate", hiddenUntilUnlock: true }),
    page({ id: "reviews", order: 40, phase: "build", category: "projects", group: "share", hiddenUntilUnlock: true }),
    page({ id: "publish", order: 30, phase: "build", category: "projects", hidden: true }),
    page({ id: "settings", footer: true }),
  ];

  it("locked: only the ungrouped, non-footer pages are foreground; groups are empty", () => {
    const model = railModel(synthetic, false);
    expect(model.foreground.map((p) => p.id)).toEqual(["overview", "curate"]);
    expect(model.groups).toEqual([]);
  });

  it("unlocked: populates all four groups in Observe/Build/Evaluate/Share order", () => {
    const model = railModel(synthetic, true);
    expect(model.groups.map((g) => g.key)).toEqual(["observe", "build", "evaluate", "share"]);
    expect(model.groups.map((g) => g.label)).toEqual(["Observe", "Build", "Evaluate", "Share"]);
    expect(model.groups.map((g) => g.pages.map((p) => p.id))).toEqual([
      ["materialize"], ["benchmark"], ["mine"], ["reviews"],
    ]);
  });

  it("gates each grouped page on its own hiddenUntilUnlock, not just the unlocked flag", () => {
    const mixed = [
      page({ id: "always-on", phase: "build", category: "projects", group: "share" }), // no hiddenUntilUnlock
      page({ id: "gated-a", phase: "build", category: "projects", group: "share", hiddenUntilUnlock: true }),
      page({ id: "gated-b", phase: "build", category: "projects", group: "share", hiddenUntilUnlock: true }),
    ];
    const locked = railModel(mixed, false);
    expect(locked.groups.map((g) => g.key)).toEqual(["share"]);
    expect(locked.groups[0].pages.map((p) => p.id)).toEqual(["always-on"]);

    const unlocked = railModel(mixed, true);
    expect(unlocked.groups[0].pages.map((p) => p.id)).toEqual(["always-on", "gated-a", "gated-b"]);
  });

  it("omits empty groups", () => {
    const model = railModel(
      [page({ id: "overview", phase: "observe", category: "usage" }), page({ id: "mine", group: "evaluate" })],
      true,
    );
    expect(model.groups.map((g) => g.key)).toEqual(["evaluate"]);
  });

  it("never surfaces a hidden page, locked or unlocked", () => {
    expect(railModel(synthetic, false).foreground.map((p) => p.id)).not.toContain("publish");
    const unlocked = railModel(synthetic, true);
    expect(unlocked.foreground.map((p) => p.id)).not.toContain("publish");
    expect(unlocked.groups.flatMap((g) => g.pages.map((p) => p.id))).not.toContain("publish");
  });

  it("excludes footer pages from foreground", () => {
    expect(railModel(synthetic, false).foreground.map((p) => p.id)).not.toContain("settings");
  });

  it("accepts a page placed only by group, with neither phase/category nor footer", () => {
    const pages = [page({ id: "grouped-only", group: "share" })];
    expect(() => railModel(pages, true)).not.toThrow();
  });

  it("still rejects a page with neither phase/category, footer, nor group", () => {
    const pages = [page({ id: "orphan" })];
    expect(() => railModel(pages, true)).toThrow();
  });
});

describe("normalizeHash", () => {
  it("redirects the legacy #/insights route to the Outcomes sub-route", () => {
    expect(normalizeHash("#/insights")).toBe("#/mine/outcomes");
  });
  it("passes #/mine and #/mine/outcomes through unchanged", () => {
    expect(normalizeHash("#/mine")).toBe("#/mine");
    expect(normalizeHash("#/mine/outcomes")).toBe("#/mine/outcomes");
  });
});
