import { describe, it, expect } from "vitest";
import { buildOptimizePayload } from "@agentgem/insight";
import { OptimizePayloadSchema } from "../../gem.controller.js";
import type { ConfigInventory } from "@agentgem/model";
import type { ArtifactUsage } from "@agentgem/insight";

const NOW = Date.parse("2026-06-29T00:00:00.000Z");

function inv(over: Partial<ConfigInventory> = {}): ConfigInventory {
  return { skills: [], mcpServers: [], instructions: [], hooks: [], ...over };
}

describe("optimizeContract", () => {
  it("buildOptimizePayload output validates against OptimizePayloadSchema (controller contract round-trip)", () => {
    const c = inv({
      skills: [
        // plugin skill
        { type: "skill", name: "brooks-review", description: "Review code", source: "plugin:brooks-lint", content: "x" },
        // standalone skill
        { type: "skill", name: "scrape", description: "Scrape a URL", source: "standalone", content: "y" },
      ],
      mcpServers: [
        // user MCP
        { type: "mcp_server", name: "coingecko", transport: "stdio", config: { command: "npx", args: ["-y", "coingecko-mcp"] }, source: "user" },
      ],
      instructions: [
        // instructions artifact
        { type: "instructions", name: "CLAUDE.md", content: "Be concise." },
      ],
    });

    const usage = new Map<string, ArtifactUsage>();
    const payload = buildOptimizePayload(c, usage, "30d", NOW);

    // Must not throw — if it does, the controller would reject its own output
    const parsed = OptimizePayloadSchema.parse(payload);
    expect(parsed.range).toBe("30d");
    expect(Array.isArray(parsed.artifacts)).toBe(true);
    expect(Array.isArray(parsed.instructions)).toBe(true);
    expect(parsed).toEqual(payload);
  });
});
