import { existsSync } from "node:fs";
import { join } from "node:path";

// Packaged builds ship a self-contained esbuild bundle of the core at
// resources/core/index.mjs (see scripts/bundle-core.mjs + extraResources). Dev
// runs against the sibling repo dist two levels up from desktop/dist, which has
// the repo's node_modules alongside it.
export function coreEntryCandidates(mainDir: string, resourcesPath: string): string[] {
  return [
    join(resourcesPath, "core", "index.mjs"),
    join(mainDir, "..", "..", "dist", "index.js"),
  ];
}

export function resolveCoreEntry(candidates: string[]): string {
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(`AgentGem core not found. Looked in:\n${candidates.join("\n")}`);
  }
  return found;
}
