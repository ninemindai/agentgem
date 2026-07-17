import type { ConsolePage, Phase, ArtifactCategory, DisclosureGroup } from "./contract.js";
export { defineConsolePage } from "./contract.js";
export type { ConsolePage, Phase, ArtifactCategory, DisclosureGroup } from "./contract.js";

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

/** Every page is either {phase, category}, {footer:true}, or {group:...} — never neither,
 *  never half of the phase pair. A `group` alone is valid on its own (the rail model doesn't
 *  need phase/category to place a page), but a miswired page with none of the three (e.g. a
 *  lost `category` field in the migration) fails loudly here instead of silently vanishing
 *  from the sidebar. */
function assertPlacement(pages: ConsolePage[]): void {
  for (const p of pages) {
    // Grouped pages skip the phase/category consistency checks below entirely — a deliberate
    // tradeoff, since the rail model places them by `group` alone and doesn't care whether
    // their (now-legacy) phase/category pair is well-formed.
    if (p.footer || p.group) continue;
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

/** Rail disclosure groups, in display order, each with its section label. */
const DISCLOSURE_GROUPS: { key: DisclosureGroup; label: string }[] = [
  { key: "make", label: "Make" },
  { key: "evidence", label: "Evidence" },
  { key: "background", label: "Background" },
  { key: "power", label: "Power tools" },
];

/** The cold-console rail: an always-visible `foreground` (no group, no footer — Overview,
 *  Curate, Gems) plus the four disclosure groups. A grouped page appears in its group once
 *  `unlocked`; while locked, it appears only if it does NOT carry `hiddenUntilUnlock` — today
 *  every grouped page does, so `groups` comes out empty until unlock, but a future page that's
 *  grouped without `hiddenUntilUnlock` would show up immediately. Groups that end up with no
 *  pages are omitted. `hidden` pages (e.g. Publish, disabled in code) never appear in either,
 *  locked or unlocked. Footer pages are out of scope here; the Shell keeps reading those from
 *  `footerPages`. */
export function railModel(
  pages: ConsolePage[],
  unlocked: boolean,
): { foreground: ConsolePage[]; groups: { key: DisclosureGroup; label: string; pages: ConsolePage[] }[] } {
  const ordered = sortedPages(pages); // duplicate-id guard
  assertPlacement(ordered);
  const visible = ordered.filter((p) => !p.hidden);
  const foreground = visible.filter((p) => !p.group && !p.footer);
  const groups = DISCLOSURE_GROUPS.map(({ key, label }) => ({
    key,
    label,
    pages: visible.filter((p) => p.group === key && (unlocked || !p.hiddenUntilUnlock)),
  })).filter((g) => g.pages.length > 0);
  return { foreground, groups };
}
