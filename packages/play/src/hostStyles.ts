// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// String-emitting port of ext-apps/src/styles.ts — applyDocumentTheme + applyHostStyleVariables, injected
// into the sealed shim so a miniapp themes to the host with no code. applyHostFonts is deliberately NOT
// ported: it injects @font-face with a URL, and SEALED_CSP.resourceDomains is [] (no font-src origin).
// Pure string. No imports, no I/O.

// The standardized keys the console maps from its warm-paper palette. A subset of McpUiStyleVariableKey;
// the shim writes whatever the host sends, this list documents what the console actually provides.
export const MCP_UI_STYLE_KEYS = [
  "--color-background-primary", "--color-background-secondary",
  "--color-text-primary", "--color-border-primary",
];

export function hostStyleScript(): string {
  return `
function applyDocumentTheme(theme) {
  if (!theme) return;
  var el = document.documentElement;
  el.setAttribute("data-theme", theme);
  el.style.setProperty("color-scheme", theme);
}
function applyHostStyleVariables(vars) {
  if (!vars) return;
  var root = document.documentElement;
  for (var k in vars) { if (Object.prototype.hasOwnProperty.call(vars, k) && vars[k] != null) root.style.setProperty(k, vars[k]); }
}`;
}
