import type { ConsolePage, Phase, ArtifactCategory } from "./contract.js";
export { defineConsolePage } from "./contract.js";
export type { ConsolePage, Phase, ArtifactCategory } from "./contract.js";

/** Fixed order of the artifact sub-labels within a phase. */
const CATEGORY_ORDER: ArtifactCategory[] = ["setup", "sessions", "projects", "usage"];

/** Sort pages for the sidebar; reject duplicate ids (a wiring mistake). */
export function sortedPages(pages: ConsolePage[]): ConsolePage[] {
  const seen = new Set<string>();
  for (const p of pages) {
    if (seen.has(p.id)) throw new Error(`duplicate ConsolePage id: ${p.id}`);
    seen.add(p.id);
  }
  return [...pages].sort((a, b) => a.order - b.order);
}

/** Every page is either {phase, category} or {footer:true} — never neither, never
 *  half of the phase pair. A miswired page (e.g. a lost `category` field in the
 *  migration) fails loudly here instead of silently vanishing from the sidebar. */
function assertPlacement(pages: ConsolePage[]): void {
  for (const p of pages) {
    if (p.footer) continue;
    if (p.phase && !p.category) throw new Error(`ConsolePage ${p.id} has a phase but no category`);
    if (p.category && !p.phase) throw new Error(`ConsolePage ${p.id} has a category but no phase`);
    if (!p.phase && !p.category) throw new Error(`ConsolePage ${p.id} has neither phase/category nor footer`);
  }
}

/** For one phase: ordered [{ category, pages }] groups in CATEGORY_ORDER, each
 *  sorted by `order`, with empty categories omitted. */
export function phaseGroups(
  pages: ConsolePage[],
  phase: Phase,
): { category: ArtifactCategory; pages: ConsolePage[] }[] {
  const ordered = sortedPages(pages); // duplicate-id guard
  assertPlacement(ordered);
  return CATEGORY_ORDER.map((category) => ({
    category,
    pages: ordered.filter((p) => p.phase === phase && p.category === category),
  })).filter((g) => g.pages.length > 0);
}

/** Phase-independent footer items (Settings). */
export function footerPages(pages: ConsolePage[]): ConsolePage[] {
  return sortedPages(pages).filter((p) => p.footer);
}
