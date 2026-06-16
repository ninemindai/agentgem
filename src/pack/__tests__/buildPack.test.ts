// tests/pack/buildPack.test.ts
import { describe, it, expect } from "vitest";
import { buildPack } from "../buildPack.js";
import type { ConfigInventory } from "../types.js";

const inv: ConfigInventory = {
  skills: [
    { type: "skill", name: "review", source: "standalone", content: "a" },
    { type: "skill", name: "plan", source: "standalone", content: "b" },
  ],
  mcpServers: [{ type: "mcp_server", name: "gh", transport: "stdio", config: {} }],
  instructions: [{ type: "instructions", name: "CLAUDE.md", content: "x" }],
  hooks: [{ type: "hook", name: "PreToolUse · Bash", event: "PreToolUse", matcher: "Bash", config: { hooks: [] }, source: "user" }],
};

describe("buildPack", () => {
  it("selects a named subset and includes instructions when asked", () => {
    const pack = buildPack(inv, { skills: ["review"], mcpServers: ["gh"], includeInstructions: true }, { name: "p", createdFrom: "/d" });
    expect(pack.name).toBe("p");
    expect(pack.createdFrom).toBe("/d");
    expect(pack.artifacts.map((a) => a.type)).toEqual(["skill", "mcp_server", "instructions"]);
    expect(pack.artifacts.map((a) => a.name)).toEqual(["review", "gh", "CLAUDE.md"]);
  });

  it("excludes instructions when not requested", () => {
    const pack = buildPack(inv, { skills: ["review"] });
    expect(pack.artifacts.some((a) => a.type === "instructions")).toBe(false);
  });

  it("{ all: true } includes everything", () => {
    const pack = buildPack(inv, { all: true });
    expect(pack.artifacts.length).toBe(5); // 2 skills + 1 mcp + 1 instructions + 1 hook
  });

  it("selects a hook by name", () => {
    const pack = buildPack(inv, { hooks: ["PreToolUse · Bash"] });
    expect(pack.artifacts.map((a) => a.type)).toEqual(["hook"]);
    expect(pack.artifacts[0].name).toBe("PreToolUse · Bash");
  });

  it("throws listing available names on an unknown selection", () => {
    expect(() => buildPack(inv, { skills: ["nope"] })).toThrow(/Available: review, plan/);
  });
});
