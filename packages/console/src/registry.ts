import type { ConsolePage } from "./contract.js";
export { defineConsolePage } from "./contract.js";
export type { ConsolePage } from "./contract.js";

/** Sort pages for the sidebar; reject duplicate ids (a wiring mistake). */
export function sortedPages(pages: ConsolePage[]): ConsolePage[] {
  const seen = new Set<string>();
  for (const p of pages) {
    if (seen.has(p.id)) throw new Error(`duplicate ConsolePage id: ${p.id}`);
    seen.add(p.id);
  }
  return [...pages].sort((a, b) => a.order - b.order);
}
