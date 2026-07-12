// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT

// "game" + the 4 genre values are structural tags the publish path writes automatically
// (Studio publishes ["game", <genre>, ...userTags]) and the marketplace reads back as the genre
// facet — so a free-form tag must never collide with them.
const RESERVED = new Set(["game", "replay", "skill-run", "project-fun", "session-heatmap"]);
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
