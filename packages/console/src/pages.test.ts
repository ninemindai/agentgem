import { describe, it, expect } from "vitest";
import { pages } from "./pages.js";
import { phaseGroups, footerPages, railModel, type Phase } from "./registry.js";

const flat = (phase: Phase) => phaseGroups(pages, phase).flatMap((g) => g.pages.map((p) => p.id));

describe("pages registry", () => {
  it("every page has a hash route", () => {
    expect(pages.every((p) => p.route.startsWith("#/"))).toBe(true);
  });

  it("groups the Observe phase by artifact category in order", () => {
    const g = phaseGroups(pages, "observe");
    expect(g.map((x) => x.category)).toEqual(["usage", "sessions", "projects", "setup"]);
    expect(g.map((x) => x.pages.map((p) => p.id))).toEqual([
      ["overview", "benchmark"],
      ["watch", "sessions", "recall", "arcade", "dreaming", "chat"],
      ["mine", "optimize"],
      ["rubrics", "setup"],
    ]);
  });

  it("groups the Build phase (Setup + Projects only; Sessions/Usage empty)", () => {
    const g = phaseGroups(pages, "build");
    expect(g.map((x) => x.category)).toEqual(["setup", "projects"]);
    expect(flat("build")).toEqual([
      "curate", "sources", "gems", "play", "rubric-library",
      "reviews", "materialize",
    ]);
  });

  it("puts only Settings and Memory in the footer", () => {
    expect(footerPages(pages).map((p) => p.id)).toEqual(["settings", "memory"]);
  });

  it("has no page that is both phased and footer, or neither (guard passes)", () => {
    expect(() => phaseGroups(pages, "observe")).not.toThrow();
    expect(() => phaseGroups(pages, "build")).not.toThrow();
  });
});

describe("railModel over the real registry", () => {
  it("locked: foreground is exactly Overview, Mine, Gems — no groups", () => {
    const model = railModel(pages, false);
    expect(model.foreground.map((p) => p.id)).toEqual(["overview", "mine", "gems"]);
    expect(model.groups).toEqual([]);
  });

  it("unlocked: the four journey groups appear in order, each in its intended sequence", () => {
    // Unlike the legacy phase/category bucket, `order` here is deliberately assigned per
    // disclosure group to encode the journey sequence (what happened → make gems → is it
    // good → ship it), so intra-group position is meaningful and asserted exactly.
    const model = railModel(pages, true);
    expect(model.foreground.map((p) => p.id)).toEqual(["overview", "mine", "gems"]);
    expect(model.groups.map((g) => g.key)).toEqual(["observe", "build", "evaluate", "share"]);
    expect(model.groups.map((g) => g.label)).toEqual(["Observe", "Build", "Evaluate", "Share"]);
    expect(model.groups.map((g) => g.pages.map((p) => p.id))).toEqual([
      ["watch", "sessions", "recall", "dreaming"],
      ["curate", "setup", "play", "materialize", "chat", "rubric-library"],
      ["rubrics", "benchmark", "reviews", "optimize"],
      ["sources", "arcade"],
    ]);
  });

  it("never surfaces Publish, locked or unlocked", () => {
    const ids = (unlocked: boolean) => {
      const m = railModel(pages, unlocked);
      return [...m.foreground, ...m.groups.flatMap((g) => g.pages)].map((p) => p.id);
    };
    expect(ids(false)).not.toContain("publish");
    expect(ids(true)).not.toContain("publish");
  });

  it("leaves the footer untouched (Settings, Memory) regardless of lock state", () => {
    expect(footerPages(pages).map((p) => p.id)).toEqual(["settings", "memory"]);
  });
});
