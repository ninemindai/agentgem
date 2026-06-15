// src/__tests__/schemas.test.ts
import { describe, it, expect } from "vitest";
import { InventorySchema, PackSchema, PackRequestSchema } from "../schemas.js";

describe("wire schemas", () => {
  it("validates an inventory shape", () => {
    const parsed = InventorySchema.parse({
      skills: [{ type: "skill", name: "review", source: "standalone", content: "x" }],
      mcpServers: [{ type: "mcp_server", name: "gh", transport: "stdio", config: { env: { T: "<redacted>" } } }],
      instructions: [{ type: "instructions", name: "CLAUDE.md", content: "y" }],
    });
    expect(parsed.skills[0].name).toBe("review");
  });

  it("validates a pack-request with an all selection", () => {
    const p = PackRequestSchema.parse({ selection: { all: true }, name: "p" });
    expect("all" in p.selection && p.selection.all).toBe(true);
  });

  it("validates a pack-request with a named selection", () => {
    const p = PackRequestSchema.parse({ selection: { skills: ["review"], includeInstructions: true } });
    expect(p.selection).toMatchObject({ skills: ["review"] });
  });

  it("accepts a Pack", () => {
    const pk = PackSchema.parse({ name: "p", createdFrom: "/d", artifacts: [{ type: "instructions", name: "CLAUDE.md", content: "y" }] });
    expect(pk.artifacts.length).toBe(1);
  });
});
