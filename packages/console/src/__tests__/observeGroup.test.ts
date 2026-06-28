import { describe, it, expect } from "vitest";
import { groupedPages } from "../registry.js";
import { defineConsolePage } from "../contract.js";

describe("groupedPages observe bucket", () => {
  it("collects pages with group 'observe'", () => {
    const page = defineConsolePage({ id: "observe", title: "Observe", order: 5, group: "observe", route: "#/observe", component: () => null });
    const g = groupedPages([page]);
    expect(g.observe.map((p) => p.id)).toEqual(["observe"]);
    expect(g.build).toEqual([]);
  });
});
