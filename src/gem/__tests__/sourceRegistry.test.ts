// src/gem/__tests__/sourceRegistry.test.ts
import { describe, it, expect } from "vitest";
import { Application } from "@agentback/core";
import { BUILTIN_SOURCES, type SourceSpec } from "@agentgem/insight";
import { AGENT_SOURCES, SourceRegistry, AgentSourcesComponent, defaultSourceRegistry } from "../sourceRegistry.js";

describe("SourceRegistry (direct)", () => {
  const r = new SourceRegistry(BUILTIN_SOURCES);
  it("all() returns the built-in sources; byId resolves", () => {
    expect(r.all().map((s) => s.id)).toEqual(["claude", "codex", "cline", "gemini", "continue", "cursor"]);
    expect(r.byId("claude")?.label).toBe("Claude Code");
    expect(r.byId("nope")).toBeUndefined();
  });
  it("defaultSourceRegistry carries the built-ins", () => {
    expect(defaultSourceRegistry.byId("claude")?.id).toBe("claude");
    expect(defaultSourceRegistry.all().length).toBe(6);
  });
});

describe("AGENT_SOURCES extension point (wired container)", () => {
  it("resolves the built-in sources AND a plugin-contributed source via the container", async () => {
    const ctx = new Application();
    const comp = new AgentSourcesComponent();
    for (const b of comp.bindings ?? []) ctx.add(b);
    for (const s of comp.services ?? []) ctx.service(s as never);
    // a plugin contributes a source the same way — a constant binding tagged for AGENT_SOURCES.
    // "windsurf" is still hypothetical (not a built-in); "cursor" is now a real built-in above,
    // so reusing it here would collide on the "agentSources.cursor" binding key.
    const pluginSource: SourceSpec = { id: "windsurf", label: "Windsurf", traits: { storage: "sqlite" }, roots: () => [] };
    const { Binding, extensionFor } = await import("@agentback/core");
    ctx.add(Binding.bind("agentSources.windsurf").to(pluginSource).apply(extensionFor(AGENT_SOURCES)));
    const registry = await ctx.get<SourceRegistry>("services.SourceRegistry");
    expect(registry.byId("windsurf")?.label).toBe("Windsurf");
    expect(registry.all().map((s) => s.id)).toContain("claude");
    // Falsifiable against partial injection: both built-ins + the 1 plugin source must wire through.
    expect(registry.all().length).toBe(7);
  });
});
