// src/gem/__tests__/gemTypes.test.ts
import { describe, it, expect } from "vitest";
import { BUILTIN_CUTS, deriveCut } from "@agentgem/model";
import type { Gem, GemArtifact } from "@agentgem/model";

const gem = (artifacts: GemArtifact[]): Gem => ({ name: "g", createdFrom: "t", artifacts, checks: [], requiredSecrets: [] });
const skill = (name: string, source = "standalone"): GemArtifact => ({ type: "skill", name, source, content: "x" });
const mcp = (name: string): GemArtifact => ({ type: "mcp_server", name, transport: "stdio", config: {} });
const instr = (name: string): GemArtifact => ({ type: "instructions", name, content: "x" });
const hook = (name: string): GemArtifact => ({ type: "hook", name, event: "PreToolUse", config: {} });

const d = (g: Gem) => deriveCut(BUILTIN_CUTS, g);

describe("deriveCut", () => {
  it("playbook — a session-distilled skill (source distilled-draft) wins over everything", () => {
    expect(d(gem([skill("s", "distilled-draft"), mcp("m")]))).toBe("playbook"); // also has mcp, but playbook is order 10
  });
  it("setup — ≥3 distinct artifact kinds", () => {
    expect(d(gem([skill("s"), instr("i"), hook("h")]))).toBe("setup");
  });
  it("integration — has an mcp_server (and <3 kinds)", () => {
    expect(d(gem([mcp("m"), instr("i")]))).toBe("integration");
  });
  it("guide — only instructions", () => {
    expect(d(gem([instr("a"), instr("b")]))).toBe("guide");
  });
  it("skill — only skills (non-distilled)", () => {
    expect(d(gem([skill("a"), skill("b")]))).toBe("skill");
  });
  it("kit — a mixed 2-kind bundle (the fallback)", () => {
    expect(d(gem([skill("a"), instr("b")]))).toBe("kit");
  });
  it("kit — an empty gem falls back", () => {
    expect(d(gem([]))).toBe("kit");
  });
});

describe("BUILTIN_CUTS", () => {
  it("has the 6 cuts with stable ids, gemstones, and ascending order", () => {
    expect(BUILTIN_CUTS.map((c) => c.id)).toEqual(["playbook", "setup", "integration", "guide", "skill", "kit"]);
    expect(BUILTIN_CUTS.find((c) => c.id === "playbook")!.gemstone).toBe("Pearl");
    expect(BUILTIN_CUTS.find((c) => c.id === "kit")!.gemstone).toBe("Amethyst");
  });
});
