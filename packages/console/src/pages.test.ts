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
      ["sessions", "recall", "watch", "chat", "dreaming", "arcade"],
      ["mine", "optimize"],
      ["setup", "rubrics"],
    ]);
  });

  it("groups the Build phase (Setup + Projects only; Sessions/Usage empty)", () => {
    const g = phaseGroups(pages, "build");
    expect(g.map((x) => x.category)).toEqual(["setup", "projects"]);
    expect(flat("build")).toEqual([
      "curate", "sources", "gems", "play", "rubric-library",
      "materialize", "deploy", "publish", "reviews",
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
  it("locked: foreground is exactly Overview, Curate, Gems — no groups", () => {
    const model = railModel(pages, false);
    expect(model.foreground.map((p) => p.id)).toEqual(["overview", "curate", "gems"]);
    expect(model.groups).toEqual([]);
  });

  it("unlocked: the four groups appear in order, each with the disposition-table membership", () => {
    // `order` is scoped to a page's (phase, category) bucket, not to its disclosure group, so
    // intra-group sequencing isn't meaningful here — assert membership (sorted for a stable
    // diff), not a specific position within the group.
    const model = railModel(pages, true);
    expect(model.foreground.map((p) => p.id)).toEqual(["overview", "curate", "gems"]);
    expect(model.groups.map((g) => g.key)).toEqual(["make", "evidence", "background", "power"]);
    expect(model.groups.map((g) => [...g.pages.map((p) => p.id)].sort())).toEqual([
      ["deploy", "materialize", "setup"],
      ["benchmark", "recall", "rubric-library", "rubrics", "sessions", "sources"],
      ["dreaming", "mine", "optimize", "watch"],
      ["arcade", "chat", "play", "reviews"],
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
