// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/model/src/gemTypes.ts
//
// A gem's "cut": an author-set intent label with a signature gemstone. Pure data +
// a default classifier. The DI extension point (GemTypeRegistry) lives in the app
// layer and resolves a set of these specs; this module has no DI dependency so the
// classifier stays trivially testable and @agentgem/model stays pure.
import type { Gem } from "./types.js";

export interface GemTypeSpec {
  id: string;          // the stored cut, e.g. "playbook"
  label: string;       // "Playbook"
  gemstone: string;    // "Pearl" — the color is the marketplace's concern (subsystem #5)
  order: number;       // derive precedence — lowest matching wins
  matches(gem: Gem): boolean;
}

const kindsOf = (gem: Gem) => new Set(gem.artifacts.map((a) => a.type));

// Order matters: a session-distilled gem is a Playbook even if it also has an MCP;
// breadth (≥3 kinds) reads as a whole-config Setup before the mcp→Integration rule.
// `kit` is the guaranteed fallback (matches everything).
export const BUILTIN_CUTS: GemTypeSpec[] = [
  { id: "playbook", label: "Playbook", gemstone: "Pearl", order: 10,
    matches: (g) => g.artifacts.some((a) => a.type === "skill" && a.source === "distilled-draft") },
  { id: "setup", label: "Setup", gemstone: "Opal", order: 20,
    matches: (g) => kindsOf(g).size >= 3 },
  { id: "integration", label: "Integration", gemstone: "Sapphire", order: 30,
    matches: (g) => kindsOf(g).has("mcp_server") },
  { id: "guide", label: "Guide", gemstone: "Topaz", order: 40,
    matches: (g) => g.artifacts.length > 0 && g.artifacts.every((a) => a.type === "instructions") },
  { id: "skill", label: "Skill", gemstone: "Emerald", order: 50,
    matches: (g) => g.artifacts.length > 0 && g.artifacts.every((a) => a.type === "skill") },
  { id: "kit", label: "Kit", gemstone: "Amethyst", order: 99, matches: () => true },
];

// The default classifier: the lowest-order spec whose matches() is true. With `kit`
// (matches:()=>true) present, this never returns undefined.
export function deriveCut(specs: GemTypeSpec[], gem: Gem): string {
  return [...specs].sort((a, b) => a.order - b.order).find((s) => s.matches(gem))!.id;
}
