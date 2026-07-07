import { describe, it, expect } from "vitest";
import { catOf, CATEGORY_COLOR } from "./toolCategory.js";

describe("catOf", () => {
  it("maps known tools to categories", () => {
    expect(catOf("Read")).toBe("read");
    expect(catOf("Edit")).toBe("write");
    expect(catOf("Bash")).toBe("bash");
    expect(catOf("Skill")).toBe("skill");
    expect(catOf("Task")).toBe("agent");
    expect(catOf("Agent")).toBe("agent");
    expect(catOf("AskUserQuestion")).toBe("ask");
    expect(catOf("TaskUpdate")).toBe("task");
    expect(catOf("Wibble")).toBe("other");
  });
  it("has a color for every category", () => {
    (["read","write","bash","skill","agent","ask","task","other"] as const)
      .forEach((c) => expect(CATEGORY_COLOR[c]).toMatch(/^var\(--/));
  });
});
