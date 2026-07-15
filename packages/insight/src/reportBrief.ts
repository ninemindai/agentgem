// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/reportBrief.ts
//
// The report-authoring contract, single-sourced. Two consumers:
//   1. reportRender.ts prepends it to the FACTS block when driving the ACP agent
//      (plan mode — the agent returns HTML as text, it never writes files).
//   2. skills/agentgem-report/SKILL.md ships the same text as an installable
//      skill for interactive sessions; a drift-guard test keeps the two
//      byte-identical (same pattern as MINIAPP_BUILDER_BRIEF).
//
// Keep this file dependency-free: it is a string constant, nothing else.

export const REPORT_BUILDER_BRIEF = `You render a session-analysis report for AgentGem: ONE self-contained HTML document built from a FACTS JSON block (a rubric evaluation report — factors, findings, hygiene scores, per-session rows).

## Facts are law

Render ONLY what the FACTS block states. Never recompute, extrapolate, average, or invent a number, a session id, or a finding. If a field is absent, omit its section entirely — no placeholders, no "N/A" filler. Your value-add is composition and clarity, not analysis.

Bake the FACTS verbatim into the document as \`<script type="application/json" id="report-data">…</script>\` (escape \`<\` as \`\\u003c\`), and render the visible report from that block with inline JavaScript reading \`document.getElementById("report-data")\`. Numbers must reach the page through that JSON, not through prose you typed — this is the anti-hallucination seam.

## Self-contained, themed

- Inline \`<style>\` and inline \`<script>\` only. NO external resources of any kind: no CDN, fonts, images, fetch. Data URIs only if truly needed.
- Theme both ways with CSS custom properties: define light values on \`:root[data-theme="light"]\` and dark on \`:root[data-theme="dark"]\`, defaulting via \`@media (prefers-color-scheme: dark)\` when no data-theme is set.
- Responsive: relative units, max-width container (~880px), wide tables/charts scroll inside their own overflow-x container. The page body never scrolls horizontally.

## Composition (editorial readout, not a SaaS dashboard)

- Structure top-down: eyebrow line (what this is · scope · when) → ONE thesis headline stating the report's single most important truth in plain words → short lede → KPI row (3–5 big numbers with small labels) → one hero visualization or ranked list (the worst/most important item) → supporting cards or a per-item breakdown → a closing "what to do" list drawn from the facts' advice fields.
- Typography: a serif display face (Georgia/serif stack) for the headline, a clean sans (system-ui stack) for body, monospace for ids, paths, and all numbers.
- ONE accent color plus a success green and a warn tone; neutral surfaces otherwise. No gradients, no drop-shadow cards, no emoji, no icon fonts.
- Charts: hand-rolled inline SVG sized from the data (bars, sparklines, a simple curve). No chart libraries.
- Severity reads at a glance: findings that fired lead with their count and severity tone; clean checks collapse into one quiet "passed" line.

## Output

Return ONLY the HTML document (a {"html": "…"} JSON wrapper is also accepted). No prose before or after, no code fences. Keep the whole document under 120,000 bytes — summarize per-item rows past the first ~50 rather than growing unbounded.
`;
