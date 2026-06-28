import { describe, it, expect } from "vitest";
import { selKey, visibleKeys, buildSelection } from "./selection.js";
import type { LedgerGroup } from "./data.js";

const groups: LedgerGroup[] = [
  { key: "skills", label: "Skills", items: [
    { name: "pdf", invocations: 1, lastUsedMs: null },
    { name: "csv", invocations: 0, lastUsedMs: null },
  ] },
  { key: "instructions", label: "Instructions", items: [
    { name: "CLAUDE.md", invocations: 0, lastUsedMs: null },
  ] },
];

describe("visibleKeys", () => {
  it("lists every item key across groups", () => {
    expect(visibleKeys(groups)).toEqual(["skills::pdf", "skills::csv", "instructions::CLAUDE.md"]);
  });
});

describe("buildSelection", () => {
  it("groups skill/mcp/hook names by category", () => {
    const sel = buildSelection(new Set([selKey("skills", "pdf"), selKey("mcpServers", "github")]));
    expect(sel).toEqual({ skills: ["pdf"], mcpServers: ["github"] });
  });

  it("maps any selected instruction to includeInstructions:true", () => {
    const sel = buildSelection(new Set([selKey("instructions", "CLAUDE.md")]));
    expect(sel).toEqual({ includeInstructions: true });
  });

  it("returns an empty object for no selection", () => {
    expect(buildSelection(new Set())).toEqual({});
  });
});
