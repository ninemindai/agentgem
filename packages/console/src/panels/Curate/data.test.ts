import { describe, it, expect } from "vitest";
import { groupInventory, mergeUsage, applyView, relativeTime, formatSource, type LedgerGroup } from "./data.js";

describe("formatSource", () => {
  it("extracts the plugin name from a plugin source", () =>
    expect(formatSource("plugin:superpowers@claude-plugins-official")).toBe("superpowers"));
  it("passes through standalone/user/project", () => {
    expect(formatSource("standalone")).toBe("standalone");
    expect(formatSource("user")).toBe("user");
  });
  it("returns undefined for no source", () => expect(formatSource(undefined)).toBeUndefined());
});

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
  it("attaches invocations + lastUsedMs by name within the category type, default 0/null", () => {
    const groups = mergeUsage(groupInventory(inv as any), usage as any);
    const pdf = groups[0].items.find((i) => i.name === "pdf")!;
    const csv = groups[0].items.find((i) => i.name === "csv")!;
    expect(pdf.invocations).toBe(5);
    expect(pdf.lastUsedMs).toBe(1);
    expect(csv.invocations).toBe(0);
    expect(csv.lastUsedMs).toBe(null);
    expect(groups[1].items[0].invocations).toBe(9);
  });
});

describe("applyView", () => {
  const groups: LedgerGroup[] = [
    { key: "skills", label: "Skills", items: [
      { name: "pdf", invocations: 5, lastUsedMs: 100 },
      { name: "csv", invocations: 0, lastUsedMs: null },
      { name: "zip", invocations: 2, lastUsedMs: 900 },
    ] },
  ];

  it("filters by case-insensitive name substring", () => {
    const out = applyView(groups, { query: "PD", sort: "uses", dir: "desc", usedOnly: false });
    expect(out[0].items.map((i) => i.name)).toEqual(["pdf"]);
  });

  it("drops zero-use items when usedOnly", () => {
    const out = applyView(groups, { query: "", sort: "uses", dir: "desc", usedOnly: true });
    expect(out[0].items.map((i) => i.name)).toEqual(["pdf", "zip"]);
  });

  it("sorts by uses desc", () => {
    const out = applyView(groups, { query: "", sort: "uses", dir: "desc", usedOnly: false });
    expect(out[0].items.map((i) => i.name)).toEqual(["pdf", "zip", "csv"]);
  });

  it("sorts by uses asc when dir is asc", () => {
    const out = applyView(groups, { query: "", sort: "uses", dir: "asc", usedOnly: false });
    expect(out[0].items.map((i) => i.name)).toEqual(["csv", "zip", "pdf"]);
  });

  it("sorts by last used desc, nulls last", () => {
    const out = applyView(groups, { query: "", sort: "last", dir: "desc", usedOnly: false });
    expect(out[0].items.map((i) => i.name)).toEqual(["zip", "pdf", "csv"]);
  });

  it("drops groups that become empty", () => {
    const out = applyView(groups, { query: "nomatch", sort: "uses", dir: "desc", usedOnly: false });
    expect(out).toEqual([]);
  });
});

describe("relativeTime", () => {
  const now = 1_000_000_000_000;
  it("returns '' for null", () => expect(relativeTime(null, now)).toBe(""));
  it("'just now' under 45s", () => expect(relativeTime(now - 10_000, now)).toBe("just now"));
  it("minutes", () => expect(relativeTime(now - 5 * 60_000, now)).toBe("5m ago"));
  it("hours", () => expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h ago"));
  it("days", () => expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2d ago"));
});
