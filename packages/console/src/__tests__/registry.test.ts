import { describe, it, expect } from "vitest";
import { defineConsolePage, sortedPages } from "../registry.js";

const page = (id: string, order: number) =>
  defineConsolePage({ id, title: id, order, route: `#/${id}`, component: () => null });

describe("sortedPages", () => {
  it("sorts pages ascending by order", () => {
    const out = sortedPages([page("b", 20), page("a", 10)]);
    expect(out.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("throws on duplicate id", () => {
    expect(() => sortedPages([page("a", 10), page("a", 20)])).toThrow(/duplicate/i);
  });
});
