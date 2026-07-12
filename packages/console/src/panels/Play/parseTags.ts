// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT

import type { GameGenre } from "@agentgem/model";

// "game" + the genre values are structural tags the publish path writes automatically
// (Studio publishes ["game", <genre>, ...userTags]) and the marketplace reads back as the genre
// facet — so a free-form tag must never collide with them. Kept as a local literal (a runtime value
// import of the model's GAME_GENRES would drag node:* modules into the browser bundle), guarded below.
const GENRE_TAGS = ["replay", "skill-run", "project-fun", "session-heatmap"] as const;
// Compile-time drift guard: GENRE_TAGS must stay in lockstep with the canonical GameGenre union
// (packages/model). `import type` is erased at build, so this costs the browser bundle nothing.
type _GenreDrift = [GameGenre] extends [(typeof GENRE_TAGS)[number]]
  ? ((typeof GENRE_TAGS)[number] extends GameGenre ? true : never)
  : never;
const _genreDrift: _GenreDrift = true;
void _genreDrift;
const RESERVED = new Set<string>(["game", ...GENRE_TAGS]);
const MAX_TAGS = 8;
const MAX_LEN = 24;

/** Parse the comma-separated tags input into a clean, capped, deduped, lowercased list. */
export function parseTags(raw: string): string[] {
  const out: string[] = [];
  for (const piece of raw.split(",")) {
    const t = piece.trim().toLowerCase();
    if (!t || t.length > MAX_LEN || RESERVED.has(t) || out.includes(t)) continue;
    out.push(t);
    if (out.length === MAX_TAGS) break;
  }
  return out;
}
