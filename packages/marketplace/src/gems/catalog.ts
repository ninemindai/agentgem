/** Curated static gem catalog. Shaped to mirror the eventual registry API, behind a small accessor
 *  seam (listGems/getGem) so a live source can drop in here without touching the pages. */

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
  ingredients: GemIngredient[]; // bundled ingredients; ids match aggregator ids for cross-linking
}

export const STATIC_GEMS: Gem[] = [
  {
    key: "brainstorming-kit", version: "1.2.0", author: "superpowers",
    description: "Turn rough ideas into approved specs through guided dialogue, then into bite-sized implementation plans.",
    tags: ["planning", "specs", "workflow"],
    artifactKinds: ["skill"],
    ingredients: [
      { id: "skill:superpowers/brainstorming", kind: "skill" },
      { id: "skill:superpowers/writing-plans", kind: "skill" },
    ],
  },
  {
    key: "tdd-starter", version: "0.9.1", author: "superpowers",
    description: "Red-green-refactor discipline: write the failing test first, make it pass, keep the suite honest.",
    tags: ["testing", "tdd", "quality"],
    artifactKinds: ["skill"],
    ingredients: [
      { id: "skill:superpowers/test-driven-development", kind: "skill" },
      { id: "skill:superpowers/writing-plans", kind: "skill" },
    ],
  },
  {
    key: "debugging-pro", version: "1.0.0", author: "superpowers",
    description: "Systematic debugging — reproduce, isolate, root-cause, and verify the fix instead of guessing.",
    tags: ["debugging", "workflow"],
    artifactKinds: ["skill"],
    ingredients: [
      { id: "skill:superpowers/systematic-debugging", kind: "skill" },
    ],
  },
  {
    key: "github-flow", version: "2.1.0", author: "ninemind",
    description: "Drive GitHub from your agent: issues, PRs, reviews, and releases via the official MCP server.",
    tags: ["github", "mcp", "git"],
    artifactKinds: ["mcp"],
    ingredients: [
      { id: "npx:@modelcontextprotocol/server-github", kind: "mcp" },
    ],
  },
  {
    key: "ship-it", version: "1.4.0", author: "ninemind",
    description: "From feature branch to merged: plan, implement with subagents, review, and finish the branch cleanly.",
    tags: ["workflow", "review", "git"],
    artifactKinds: ["skill"],
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
    artifactKinds: ["mcp"],
    ingredients: [
      { id: "npx:@playwright/mcp", kind: "mcp" },
    ],
  },
  {
    key: "fullstack-starter", version: "1.1.0", author: "ninemind",
    description: "A batteries-included bundle: planning, TDD, debugging, and GitHub — everything to ship a feature.",
    tags: ["bundle", "workflow", "starter"],
    artifactKinds: ["skill", "mcp"],
    ingredients: [
      { id: "skill:superpowers/brainstorming", kind: "skill" },
      { id: "skill:superpowers/test-driven-development", kind: "skill" },
      { id: "skill:superpowers/systematic-debugging", kind: "skill" },
      { id: "npx:@modelcontextprotocol/server-github", kind: "mcp" },
    ],
  },
];

/** @deprecated use STATIC_GEMS — kept so existing imports don't break until Task 4 */
export const GEMS: Gem[] = STATIC_GEMS;

export function listGems(): Gem[] { return STATIC_GEMS; }

export function getGem(key: string): Gem | undefined { return STATIC_GEMS.find((g) => g.key === key); }

/** Case-insensitive substring match over key + description + tags; all gems on blank. */
export function filterGems(gems: Gem[], query: string): Gem[] {
  const q = query.trim().toLowerCase();
  if (q === "") return gems;
  return gems.filter(
    (g) =>
      g.key.toLowerCase().includes(q) ||
      g.description.toLowerCase().includes(q) ||
      g.tags.some((t) => t.toLowerCase().includes(q)),
  );
}

import type { RegistryGem } from "../types";
import type { makeApi } from "../api";

function toGem(r: RegistryGem): Gem {
  return { key: r.key, version: r.version, author: r.author, description: r.description ?? "", tags: r.tags ?? [], artifactKinds: r.artifactKinds ?? [], ingredients: [] };
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
