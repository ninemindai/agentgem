// src/__tests__/mcpNeedsSchema.test.ts
import { describe, it, expect } from "vitest";
import type { McpNeed } from "@agentgem/model";
import type { z } from "zod";
import { McpNeedSchema, McpNeedsSchema, GameArtifactSchema, PlaySaveRequestSchema, PlaySaveResponseSchema, PlayMiniappSchema, MiniappListSchema } from "@agentgem/app/schemas";

// Compile-time lockstep pin: the wire schema and the model type must be assignable both ways.
// If either side drifts, this file stops compiling — the drift guard for a STRUCTURED shape,
// where the enum-style value-list guard doesn't apply.
const _wireToModel: McpNeed = {} as z.infer<typeof McpNeedSchema>;
const _modelToWire: z.infer<typeof McpNeedSchema> = {} as McpNeed;
void _wireToModel; void _modelToWire;

const NEED = { server: "github", tools: ["list_pull_requests", "list_commits"] };

describe("McpNeedSchema", () => {
  it("accepts a server with its tool list", () => {
    expect(McpNeedSchema.parse(NEED)).toEqual(NEED);
  });

  it("rejects an empty server name and empty tool names", () => {
    expect(() => McpNeedSchema.parse({ server: "", tools: ["a"] })).toThrow();
    expect(() => McpNeedSchema.parse({ server: "github", tools: [""] })).toThrow();
  });

  it("is optional everywhere it travels (absent stays absent)", () => {
    expect(McpNeedsSchema.parse(undefined)).toBeUndefined();
  });
});

describe("mcpNeeds on the wire", () => {
  const createdFrom = { kind: "blank" as const, title: "t" };

  it("rides GameArtifactSchema", () => {
    const a = GameArtifactSchema.parse({
      type: "game", name: "g", title: "G", genre: "project-fun", html: "<canvas></canvas>",
      createdFrom, engineVersion: "1", mcpNeeds: [NEED],
    });
    expect(a.mcpNeeds).toEqual([NEED]);
  });

  it("rides the save request meta and the miniapp read meta", () => {
    const req = PlaySaveRequestSchema.parse({
      name: "g", html: "<x/>",
      meta: { title: "G", genre: "project-fun", createdFrom, mcpNeeds: [NEED] },
    });
    expect(req.meta.mcpNeeds).toEqual([NEED]);
    const read = PlayMiniappSchema.parse({
      name: "g", html: "<x/>",
      meta: { title: "G", genre: "project-fun", createdFrom, engineVersion: "1", mcpNeeds: [NEED] },
    });
    expect(read.meta.mcpNeeds).toEqual([NEED]);
    const list = MiniappListSchema.parse({ miniapps: [{ name: "g", title: "G", genre: "project-fun", mcpNeeds: [NEED] }] });
    expect(list.miniapps[0].mcpNeeds).toEqual([NEED]);
  });

  it("save response surfaces mcpWarnings, defaulting to []", () => {
    const res = PlaySaveResponseSchema.parse({ name: "g", commit: null, prunedNeeds: [] });
    expect(res.mcpWarnings).toEqual([]);
  });
});
