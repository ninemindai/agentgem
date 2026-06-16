// src/browse.ts
// Server-backed folder browser. Lists immediate subdirectory NAMES only (never file
// contents), clamped to within the user's home dir. This is the only filesystem-listing
// surface; it exposes folder structure under home, nothing more.
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveUnderHome } from "./resolveDir.js";

export interface BrowseResult {
  path: string;
  parent: string | null;
  dirs: { name: string; path: string }[];
}

export function browseDir(p?: string): BrowseResult {
  const path = resolveUnderHome(p);
  const home = homedir();
  let dirs: BrowseResult["dirs"] = [];
  try {
    dirs = readdirSync(path, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, path: join(path, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    // unreadable / not a directory -> empty listing, no throw
    dirs = [];
  }
  // Never navigate above home.
  const parent = path === home ? null : dirname(path);
  return { path, parent, dirs };
}
