# Insight House-Style Adoption (slice 2) — Design

**Date:** 2026-07-24
**Status:** Approved (design), implemented
**Scope:** `packages/insight/src/reportRender.ts` — the rubric-report ACP prompt injects the shared
`houseStyle` CSS spine. Follows slice 1 (`2026-07-24-miniapp-template-house-style-design.md`), which
defined the `document`/`fixed` theme adapters with no consumer.

## Problem

AgentGem generates HTML from three ACP/scaffold surfaces; slice 1 gave the miniapp scaffolds a shared
token system (`@agentgem/model` `houseStyle`) and left the report + dashboard ACP prompts describing
their look in **prose** that re-derives the same tokens. The rubric report — the primary "report we
generate with a rubric" — should render in the same house style, from the same tokens, rather than
each render reinventing serif/sans/mono, one-accent-plus-ok-plus-warn, and the dual-theme pattern.

## Design

`buildReportPrompt` injects a house-style CSS block **between** the brief and the FACTS:

```
REPORT_BUILDER_BRIEF            (prose contract — unchanged)
HOUSE_STYLE_BLOCK              (HOUSE_TOKENS + themeAdapter("document") + kpiRow/dataTable/svgBar)
REPORT: "<title>" …
FACTS (JSON): …
```

**Runtime injection, not baked into the constant.** `REPORT_BUILDER_BRIEF` is byte-mirrored into
`skills/agentgem-report/SKILL.md` under a drift guard (`reportSkill.test.ts:22`,
`md().endsWith(REPORT_BUILDER_BRIEF)`). Interpolating the CSS into the constant would force that
markdown to be regenerated on every `houseStyle` colour tweak. Instead the constant stays prose and
`buildReportPrompt` composes the CSS at call time — the human contract keeps its description, the
agent gets the bytes. `buildReportPrompt(...).startsWith(REPORT_BUILDER_BRIEF)` (line 46) stays true
because the block goes after the brief.

**No conflict with the brief's prose.** `houseStyle` was reverse-engineered from this brief's own
theming/typography prose in slice 1 (serif/sans/mono stacks, `data-theme` + `prefers-color-scheme`,
one accent + success + warn), so the injected block *is* the exact values behind instructions the
brief already gives. Injecting is 1.6 KB per render.

**Contained to `packages/insight`.** The block is composed inline in `reportRender.ts` from the
existing `@agentgem/model` exports rather than adding a helper to the already-merged model module —
smaller blast radius, one package touched.

## Dashboard: deliberately deferred

The spec's slice-2 sketch also named `dashboardRender`. Close reading deferred it: the dashboard's
visual contract uses `'Fraunces'`/`'Hanken Grotesk'` fonts (Georgia/sans fallback) and ships its own
tuned `EXEMPLAR`. `themeAdapter("fixed")`'s **colours** already match it exactly (they were sourced
from `dashboardRender` when the adapter was written), so the dashboard barely benefits, while
injecting `HOUSE_TOKENS` would swap its **fonts** — a look-changing edit to a tuned surface. Folding
that into this PR under-examined is the wrong trade. Left as an explicit follow-up.

## Files changed

| File | Change |
| --- | --- |
| `packages/insight/src/reportRender.ts` | `HOUSE_STYLE_BLOCK` const + inject in `buildReportPrompt` |
| `src/__tests__/reportSkill.test.ts` | assert the spine is injected, verbatim, after the brief and before the facts |

## Testing

- New assertion: `buildReportPrompt` contains `HOUSE_TOKENS` and `themeAdapter("document")` verbatim,
  still `startsWith(REPORT_BUILDER_BRIEF)`, and the spine precedes `FACTS (JSON)`.
- Existing drift guard (`md().endsWith(REPORT_BUILDER_BRIEF)`) stays green — the constant is untouched.
- Browser-verified the CSS block renders a sample report in both light and `data-theme="dark"` (the
  document adapter's `prefers-color-scheme` + `data-theme` theming both resolve). The agent's own
  output is LLM-generated and not deterministically verifiable; this checks the bytes it is handed.

## Out of scope / follow-ups

- `dashboardRender` adopting `themeAdapter("fixed")` (see above).
- Retrofitted report exemplars around the `#report-data` seam — the slice-1 "spine, no exemplar"
  decision holds; revisit only if renders come back off-style.
- Blank `docTemplate` (miniapp-side, unrelated to reports).
