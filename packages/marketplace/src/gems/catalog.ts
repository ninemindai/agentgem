/** Curated static gem catalog. Used as fallback when the live registry is empty or unavailable. */

export interface GemIngredient {
  id: string;   // an aggregator ingredient id, e.g. "skill:superpowers/brainstorming" or "npx:@scope/pkg"
  kind: string; // "skill" | "mcp" | …
}

export interface Gem {
  key: string;            // unique, url-safe (e.g. "brainstorming-kit")
  version: string;        // e.g. "1.2.0"
  author?: string;
  description: string;
  tags: string[];
  artifactKinds: string[];      // e.g. ["skill","mcp"] — chip row
  cut?: string;                  // gem cut (type), e.g. "kit" | "skill" | "integration" | "setup"
  grade?: number;                // authoring quality floor (1–3); blended with community stars into the 1–5 rating
  ingredients: GemIngredient[]; // bundled ingredients; ids match aggregator ids for cross-linking
}

export const STATIC_GEMS: Gem[] = [
  {
    key: "brainstorming-kit", version: "1.2.0", author: "superpowers",
    description: "Turn rough ideas into approved specs through guided dialogue, then into bite-sized implementation plans.",
    tags: ["planning", "specs", "workflow"],
    artifactKinds: ["skill"], cut: "kit",
    ingredients: [
      { id: "skill:superpowers/brainstorming", kind: "skill" },
      { id: "skill:superpowers/writing-plans", kind: "skill" },
    ],
  },
  {
    key: "tdd-starter", version: "0.9.1", author: "superpowers",
    description: "Red-green-refactor discipline: write the failing test first, make it pass, keep the suite honest.",
    tags: ["testing", "tdd", "quality"],
    artifactKinds: ["skill"], cut: "kit",
    ingredients: [
      { id: "skill:superpowers/test-driven-development", kind: "skill" },
      { id: "skill:superpowers/writing-plans", kind: "skill" },
    ],
  },
  {
    key: "debugging-pro", version: "1.0.0", author: "superpowers",
    description: "Systematic debugging — reproduce, isolate, root-cause, and verify the fix instead of guessing.",
    tags: ["debugging", "workflow"],
    artifactKinds: ["skill"], cut: "skill",
    ingredients: [
      { id: "skill:superpowers/systematic-debugging", kind: "skill" },
    ],
  },
  {
    key: "github-flow", version: "2.1.0", author: "ninemind",
    description: "Drive GitHub from your agent: issues, PRs, reviews, and releases via the official MCP server.",
    tags: ["github", "mcp", "git"],
    artifactKinds: ["mcp"], cut: "integration",
    ingredients: [
      { id: "npx:@modelcontextprotocol/server-github", kind: "mcp" },
    ],
  },
  {
    key: "ship-it", version: "1.4.0", author: "ninemind",
    description: "From feature branch to merged: plan, implement with subagents, review, and finish the branch cleanly.",
    tags: ["workflow", "review", "git"],
    artifactKinds: ["skill"], cut: "kit",
    ingredients: [
      { id: "skill:superpowers/subagent-driven-development", kind: "skill" },
      { id: "skill:superpowers/requesting-code-review", kind: "skill" },
      { id: "skill:superpowers/finishing-a-development-branch", kind: "skill" },
    ],
  },
  {
    key: "browser-pilot", version: "0.6.2", author: "community",
    description: "Drive a real browser over CDP — screenshots, clicks, and DOM reads — for end-to-end web tasks.",
    tags: ["browser", "automation", "mcp"],
    artifactKinds: ["mcp"], cut: "integration",
    ingredients: [
      { id: "npx:@playwright/mcp", kind: "mcp" },
    ],
  },
  {
    key: "fullstack-starter", version: "1.1.0", author: "ninemind",
    description: "A batteries-included bundle: planning, TDD, debugging, and GitHub — everything to ship a feature.",
    tags: ["bundle", "workflow", "starter"],
    artifactKinds: ["skill", "mcp"], cut: "setup",
    ingredients: [
      { id: "skill:superpowers/brainstorming", kind: "skill" },
      { id: "skill:superpowers/test-driven-development", kind: "skill" },
      { id: "skill:superpowers/systematic-debugging", kind: "skill" },
      { id: "npx:@modelcontextprotocol/server-github", kind: "mcp" },
    ],
  },
];

/** Case-insensitive substring match over key + description + tags; all gems on blank. Optional cuts array narrows by cut (AND-ed; empty = all). */
export function filterGems(gems: Gem[], query: string, cuts: string[] = []): Gem[] {
  const q = query.trim().toLowerCase();
  return gems.filter(
    (g) =>
      (q === "" ||
        g.key.toLowerCase().includes(q) ||
        g.description.toLowerCase().includes(q) ||
        g.tags.some((t) => t.toLowerCase().includes(q))) &&
      (cuts.length === 0 || (g.cut !== undefined && cuts.includes(g.cut))),
  );
}

import type { RegistryGem } from "../types";
import type { makeApi } from "../api";

function toGem(r: RegistryGem): Gem {
  return { key: r.key, version: r.version, author: r.author, description: r.description ?? "", tags: r.tags ?? [], artifactKinds: r.artifactKinds ?? [], cut: r.type, grade: r.grade, ingredients: [] };
}

/** Live registry gems, or the curated STATIC_GEMS when the registry is empty/unconfigured/errors. */
export async function loadGems(api: ReturnType<typeof makeApi>): Promise<Gem[]> {
  try {
    const live = await api.getGems();
    return live.length > 0 ? live.map(toGem) : STATIC_GEMS;
  } catch {
    return STATIC_GEMS;
  }
}

export function findGem(gems: Gem[], key: string): Gem | undefined { return gems.find((g) => g.key === key); }
