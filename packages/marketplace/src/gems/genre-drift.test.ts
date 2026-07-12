import { describe, it, expect } from "vitest";
import { GAME_GENRES as CANONICAL_GENRES } from "@agentgem/model";
import { GAME_GENRES } from "./catalog";

// The marketplace SPA is deliberately standalone (zero @agentgem/* RUNTIME deps), so it keeps its own
// local copy of the genre list rather than importing the canonical one into the shipped bundle. This
// test runs in vitest — CI's `pnpm --filter @agentgem/marketplace test` step — and NOT in the SPA
// bundle (vite build never reaches test files), so it is the drift guard without costing bundle purity:
// if a genre is added to or removed from @agentgem/model's canonical GAME_GENRES, the local copy in
// catalog.ts must be updated in lockstep or this fails.
describe("genre list drift guard", () => {
  it("marketplace GAME_GENRES matches the canonical @agentgem/model GAME_GENRES", () => {
    expect([...GAME_GENRES].sort()).toEqual([...CANONICAL_GENRES].sort());
  });
});
