// src/gem/__tests__/gemTypeRegistry.test.ts
import { describe, it, expect } from "vitest";
import { Application } from "@agentback/core";
import { BUILTIN_CUTS, type Gem, type GemArtifact, type GemTypeSpec } from "@agentgem/model";
import { GEM_TYPES, GemTypeRegistry, GemTypesComponent, defaultGemTypeRegistry } from "../gemTypeRegistry.js";

const gem = (artifacts: GemArtifact[]): Gem => ({ name: "g", createdFrom: "t", artifacts, checks: [], requiredSecrets: [] });

describe("GemTypeRegistry (direct)", () => {
  const r = new GemTypeRegistry(BUILTIN_CUTS);
  it("all() returns cuts sorted by order; byId resolves; derive matches deriveCut", () => {
    expect(r.all().map((c) => c.id)).toEqual(["playbook", "setup", "integration", "guide", "skill", "kit"]);
    expect(r.byId("playbook")?.gemstone).toBe("Pearl");
    expect(r.byId("nope")).toBeUndefined();
    expect(r.derive(gem([{ type: "mcp_server", name: "m", transport: "stdio", config: {} }]))).toBe("integration");
  });
  it("defaultGemTypeRegistry carries the built-ins", () => {
    expect(defaultGemTypeRegistry.all().length).toBe(6);
  });
});

describe("GEM_TYPES extension point (wired container)", () => {
  it("resolves the built-in cuts AND a plugin-contributed cut via the container", async () => {
    const ctx = new Application();
    const comp = new GemTypesComponent();
    for (const b of comp.bindings ?? []) ctx.add(b);
    for (const s of comp.services ?? []) ctx.service(s as never);
    // a plugin contributes a cut the same way — a constant binding tagged for GEM_TYPES
    const pluginCut: GemTypeSpec = { id: "starter", label: "Starter", gemstone: "Garnet", order: 25, matches: () => false };
    const { Binding, extensionFor } = await import("@agentback/core");
    ctx.add(Binding.bind("gemTypes.cut.starter").to(pluginCut).apply(extensionFor(GEM_TYPES)));
    const registry = await ctx.get<GemTypeRegistry>("services.GemTypeRegistry");
    expect(registry.byId("starter")?.label).toBe("Starter");
    expect(registry.all().map((c) => c.id)).toContain("playbook");
    // Falsifiable against partial injection: all 6 built-ins + the 1 plugin cut must wire through.
    expect(registry.all().length).toBe(7);
  });
});
