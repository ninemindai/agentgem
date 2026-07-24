// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The shared visual contract for every self-contained HTML document AgentGem generates: miniapp
// scaffolds (packages/play) today, and the report + dashboard render agents (packages/insight) in
// slice 2. ONE token vocabulary, three bindings — a surface changes how a token resolves, never
// what it is called.
//
// Lives in @agentgem/model because it is the nearest common ancestor of play and insight.
// Pure strings. No imports, no I/O.

/** Colour tokens EVERY themeAdapter mode must bind. The drift test iterates this list, so a token
 *  added to one binding and forgotten in another fails rather than rendering `unset`.
 *  Deliberately has no dim-text token: only four host variables exist (play/hostStyles.ts), none of
 *  them a secondary text colour, so dim text is expressed with `opacity` instead. */
export const HOUSE_TOKEN_NAMES = [
  "--ink", "--surface", "--surface-2", "--border", "--accent", "--ok", "--warn",
] as const;

/** Surface-invariant tokens: type stack, scale, spacing, radius. Identical on every surface. */
export const HOUSE_TOKENS = `:root{
  --serif: ui-serif, Georgia, "Times New Roman", serif;
  --sans: system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --t-display: 28px; --t-h2: 17px; --t-body: 14px; --t-small: 11px;
  --sp-1: 6px; --sp-2: 12px; --sp-3: 18px; --sp-4: 30px;
  --radius: 8px;
}`;

export type ThemeMode = "host" | "document" | "fixed";

// Accent/status colours are literal in every mode: no host variable carries them, and the report's
// light/dark pair uses the same hues at both ends.
const ACCENT = `--accent:#c96442; --ok:#5f7a4a; --warn:#b0552f;`;

/** Bind the shared token names for one surface. */
export function themeAdapter(mode: ThemeMode): string {
  if (mode === "host") {
    // Miniapps: the host may inject its palette; most hosts send none, so the fallback is what renders.
    return `:root{
  --ink: var(--color-text-primary, #e8edf4);
  --surface: var(--color-background-primary, #0d1117);
  --surface-2: var(--color-background-secondary, #151b24);
  --border: var(--color-border-primary, #263041);
  ${ACCENT}
}`;
  }
  if (mode === "document") {
    // Standalone documents (reports): explicit data-theme wins, prefers-color-scheme is the default.
    return `:root{ --ink:#141413; --surface:#faf9f5; --surface-2:#f0eee6; --border:#d1cfc5; ${ACCENT} }
:root[data-theme="dark"]{ --ink:#e8e6e1; --surface:#131312; --surface-2:#1d1d1b; --border:#3d3d3a; }
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){ --ink:#e8e6e1; --surface:#131312; --surface-2:#1d1d1b; --border:#3d3d3a; }
}`;
  }
  // Dashboard: a fixed palette, no theming — it renders inside a host that supplies no variables.
  return `:root{ --ink:#20190f; --surface:#f1eadb; --surface-2:#e6dcc8; --border:#cdc0a6;
  --accent:#9a3324; --ok:#2f6b3a; --warn:#9a3324; }`;
}

/** Structural CSS a scaffold opts into. Class names are prefixed `hs-` so they cannot collide with
 *  whatever the Studio agent writes inside the AGENTGEM:GAME-LOGIC markers. */
export const HOUSE_PARTIALS = {
  kpiRow: `.hs-kpis{display:flex;flex-wrap:wrap;gap:var(--sp-3);margin:var(--sp-3) 0}
.hs-kpi{min-width:88px}
.hs-kpi b{display:block;font:600 24px/1.1 var(--mono);color:var(--ink)}
.hs-kpi span{display:block;font:500 var(--t-small)/1.4 var(--sans);text-transform:uppercase;letter-spacing:.08em;opacity:.6;margin-top:3px}`,

  dataTable: `.hs-table{width:100%;border-collapse:collapse;font:var(--t-body)/1.5 var(--sans)}
.hs-table th{text-align:left;font:600 var(--t-small) var(--sans);text-transform:uppercase;letter-spacing:.08em;opacity:.6;padding:0 var(--sp-2) var(--sp-1) 0}
.hs-table td{padding:var(--sp-1) var(--sp-2) var(--sp-1) 0;border-top:1px solid var(--border);vertical-align:top}
.hs-table td.hs-num{font:var(--t-body) var(--mono);text-align:right}
.hs-scroll{overflow-x:auto}`,

  svgBar: `.hs-bar{display:block;width:100%;height:auto}
.hs-bar rect{fill:var(--accent)}
.hs-bar text{fill:var(--ink);font:var(--t-small) var(--mono);opacity:.75}`,
} as const;
