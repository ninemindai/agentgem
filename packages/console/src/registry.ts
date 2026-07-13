import type { ConsolePage, Phase, ArtifactCategory } from "./contract.js";
export { defineConsolePage } from "./contract.js";
export type { ConsolePage, Phase, ArtifactCategory } from "./contract.js";

/** Order of the artifact sub-labels, per phase. Observe leads with Usage (Overview is the
 *  home dashboard) and drops Configuration to the bottom; Build leads with Setup (Curate is
 *  the entry point). */
const CATEGORY_ORDER: Record<Phase, ArtifactCategory[]> = {
  observe: ["usage", "sessions", "projects", "setup"],
  build: ["setup", "sessions", "projects", "usage"],
};

/** Legacy hash routes → their new home after the Gems merge. Exact-path match only. */
const LEGACY_ROUTES: Record<string, string> = {
  "#/your-gems": "#/gems",
  "#/received": "#/gems/received",
  "#/get-gems": "#/gems/market",
  "#/inspect": "#/overview", // the Overview dashboard was renamed from Inspect
  "#/insights": "#/mine/outcomes", // Insights folded into Mine as the Outcomes view
};

/** Rewrite a legacy route to its current one, preserving any `?query` verbatim.
 *  Idempotent (already-current hashes pass through), so it is safe to run on every
 *  hashchange and on the initial resolve without looping. */
export function normalizeHash(hash: string): string {
  const qIdx = hash.indexOf("?");
  const path = qIdx === -1 ? hash : hash.slice(0, qIdx);
  const query = qIdx === -1 ? "" : hash.slice(qIdx);
  const mapped = LEGACY_ROUTES[path];
  if (mapped) return mapped + query;
  // The transcript drill-down moved from Inspect to the Sessions screen; the bare
  // #/inspect dashboard route was renamed to #/overview (handled by LEGACY_ROUTES above).
  // Here, only the legacy /<agent>/<sessionId> drill-down sub-paths rewrite to Sessions.
  if (path.startsWith("#/inspect/")) return "#/sessions/" + path.slice("#/inspect/".length) + query;
  return hash;
}

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
  return CATEGORY_ORDER[phase].map((category) => ({
    category,
    pages: ordered.filter((p) => p.phase === phase && p.category === category),
  })).filter((g) => g.pages.length > 0);
}

/** Phase-independent footer items (Settings). */
export function footerPages(pages: ConsolePage[]): ConsolePage[] {
  return sortedPages(pages).filter((p) => p.footer);
}
