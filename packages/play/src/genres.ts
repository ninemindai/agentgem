// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The genre registry — the one place that knows what each genre is FOR. Adding a genre (or a future
// kind like a non-game miniapp) is one entry here + one scaffold + one sourceContext branch.
import type { GameGenre, GameSource } from "@agentgem/model";

export interface GenreSpec {
  id: GameGenre;
  sourceKind: GameSource["kind"];
  title: string;
  scaffold: string;   // scaffold id (see scaffolds.ts)
  guidance: string;   // genre-specific prompt guidance used to seed the studio
}

export const GENRES: Record<GameGenre, GenreSpec> = {
  replay: {
    id: "replay", sourceKind: "session", title: "Session Replay", scaffold: "replay",
    guidance:
      "Build a short, animated, playable replay of the coding session in the DATA: a timeline the player " +
      "advances, surfacing the key moments (tool calls, edits, errors, the fix). Delightful, not a log dump.",
  },
  "skill-run": {
    id: "skill-run", sourceKind: "skill", title: "Skill Run", scaffold: "skill-run",
    guidance:
      "Build a playable challenge that exercises the SKILL in the DATA: the player practices or is quizzed on " +
      "the skill's triggers and steps. Short rounds; reward correct application.",
  },
  "project-fun": {
    id: "project-fun", sourceKind: "project", title: "Project Fun", scaffold: "project-fun",
    guidance:
      "Build a light, themed mini-game seeded by the PROJECT in the DATA (name, flavor, notable files). Theme " +
      "the visuals and copy to the project; gameplay can be simple.",
  },
};

export function genreFor(id: string): GenreSpec {
  const spec = (GENRES as Record<string, GenreSpec>)[id];
  if (!spec) throw new Error(`unknown genre '${id}'`);
  return spec;
}
