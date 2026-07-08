import { describe, it, expect } from "vitest";
import { buildOptimizePayload } from "../optimizeAnalyze.js";
import type { ConfigInventory } from "@agentgem/model";
import type { ArtifactUsage } from "../workflowScan.js";

const inv = (): ConfigInventory => ({
  skills: [
    { type: "skill", name: "g-skill", source: "user", description: "d" } as any,
    { type: "skill", name: "p-skill", source: "project", description: "d" } as any,
  ],
  mcpServers: [], instructions: [], hooks: [], subagents: [],
});

describe("buildOptimizePayload layer", () => {
  it("tags global-source rows layer:global and project-source rows layer:project", () => {
    const usage = new Map<string, ArtifactUsage>();
    const p = buildOptimizePayload(inv(), usage, "all", 1_000_000_000);
    const g = p.artifacts.find((a) => a.name === "g-skill")!;
    const pr = p.artifacts.find((a) => a.name === "p-skill")!;
    expect(g.layer).toBe("global");
    expect(pr.layer).toBe("project");
  });

  it("points a project row's change.file at the project root when root is passed", () => {
    const usage = new Map<string, ArtifactUsage>();
    const p = buildOptimizePayload(inv(), usage, "all", 1_000_000_000, "/repo/x");
    const pr = p.artifacts.find((a) => a.name === "p-skill")!;
    expect(pr.change.file).toBe("/repo/x/.claude/skills/p-skill");
  });
});
