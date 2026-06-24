import { existsSync } from "node:fs";
import { join } from "node:path";

// Mirrors the core's own candidate-path probing (src/index.ts looks for
// index.html in two places). Packaged builds copy the core's dist into
// resources/core via electron-builder extraResources; dev runs against the
// sibling repo dist two levels up from desktop/dist.
export function coreEntryCandidates(mainDir: string, resourcesPath: string): string[] {
  return [
    join(resourcesPath, "core", "index.js"),
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
