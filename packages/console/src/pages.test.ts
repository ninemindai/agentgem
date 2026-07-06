import { describe, it, expect } from "vitest";
import { pages } from "./pages.js";
import { phaseGroups, footerPages, type Phase } from "./registry.js";

const flat = (phase: Phase) => phaseGroups(pages, phase).flatMap((g) => g.pages.map((p) => p.id));

describe("pages registry", () => {
  it("every page has a hash route", () => {
    expect(pages.every((p) => p.route.startsWith("#/"))).toBe(true);
  });

  it("groups the Observe phase by artifact category in order", () => {
    const g = phaseGroups(pages, "observe");
    expect(g.map((x) => x.category)).toEqual(["setup", "sessions", "projects", "usage"]);
    expect(g.map((x) => x.pages.map((p) => p.id))).toEqual([
      ["observe", "rubrics"],
      ["watch", "chat", "dreaming"],
      ["mine", "optimize"],
      ["insights", "benchmark"],
    ]);
  });

  it("groups the Build phase (Setup + Projects only; Sessions/Usage empty)", () => {
    const g = phaseGroups(pages, "build");
    expect(g.map((x) => x.category)).toEqual(["setup", "projects"]);
    expect(flat("build")).toEqual([
      "curate", "sources", "your-gems", "received", "get-gems", "rubric-library",
      "materialize", "deploy", "publish",
    ]);
  });

  it("puts only Settings in the footer", () => {
    expect(footerPages(pages).map((p) => p.id)).toEqual(["settings"]);
  });

  it("has no page that is both phased and footer, or neither (guard passes)", () => {
    expect(() => phaseGroups(pages, "observe")).not.toThrow();
    expect(() => phaseGroups(pages, "build")).not.toThrow();
  });
});
