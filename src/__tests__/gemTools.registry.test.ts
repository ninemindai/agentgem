// src/__tests__/gemTools.registry.test.ts
import { describe, it, expect } from "vitest";
import { RegistryTools } from "../registry.controller.js";

describe("registry MCP tools", () => {
  it("registry_resolve errors clearly when the registry is unconfigured", async () => {
    const prev = process.env.AGENTGEM_REGISTRY_REPO;
    delete process.env.AGENTGEM_REGISTRY_REPO;
    try {
      await expect(new RegistryTools().registryResolve({ refs: ["@a/x"], mode: "workspace" }))
        .rejects.toThrow(/registry is not configured/i);
    } finally {
      if (prev !== undefined) process.env.AGENTGEM_REGISTRY_REPO = prev;
    }
  });
});
