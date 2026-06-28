import { describe, it, expect } from "vitest";
import { groupInventory, mergeUsage } from "./data.js";

const inv = {
  skills: [{ name: "pdf" }, { name: "csv" }],
  mcpServers: [{ name: "github" }],
  instructions: [],
  hooks: [],
};

const usage = {
  artifacts: [
    { type: "skill", name: "pdf", root: null, invocations: 5, sessionsUsedIn: 2, lastUsedMs: 1 },
    { type: "mcpServer", name: "github", root: null, invocations: 9, sessionsUsedIn: 3, lastUsedMs: 2 },
  ],
};

describe("groupInventory", () => {
  it("makes one group per non-empty category in fixed order", () => {
    const groups = groupInventory(inv as any);
    expect(groups.map((g) => g.key)).toEqual(["skills", "mcpServers"]);
    expect(groups[0].label).toBe("Skills");
    expect(groups[0].items.map((i) => i.name)).toEqual(["pdf", "csv"]);
  });
});

describe("mergeUsage", () => {
  it("attaches invocations by name within the category type, default 0", () => {
    const groups = mergeUsage(groupInventory(inv as any), usage as any);
    const pdf = groups[0].items.find((i) => i.name === "pdf")!;
    const csv = groups[0].items.find((i) => i.name === "csv")!;
    expect(pdf.invocations).toBe(5);
    expect(csv.invocations).toBe(0);
    expect(groups[1].items[0].invocations).toBe(9);
  });
});
