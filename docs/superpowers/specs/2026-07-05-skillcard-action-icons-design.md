# Skill-card action icons + explicit Reviews entry

**Date:** 2026-07-05
**Scope:** `packages/marketplace` only — `pages/PopularSkills.tsx`, a new `icons.tsx`, `styles.css`, tests. No API or data changes.

## Problem

On the Popular-skills cards, the footer actions are plain muted text ("Preview",
"View on GitHub →") with weak affordance, and the only path to a skill's reviews
is clicking the skill *name* — which nothing signals as clickable-to-review. The
`★ avg · count` rating chip looks like the reviews entry but is inert.

## Design

**Actions row** — three icon+label actions in `.ex-skillcard-actions`, icons as
inline 14px SVGs from GitHub's MIT-licensed Octicons set, `fill="currentColor"`
and `aria-hidden="true"` so they inherit the existing muted→brand hover:

- **Preview** (`eye` icon) — same modal-opening button.
- **GitHub** (`mark-github` icon) — replaces "View on GitHub →"; label shortens
  to "GitHub", keeps `target="_blank" rel="noreferrer"`.
- **Reviews** (`comment` icon) — new link to the existing skill page
  `/skill/<sourceId>/<path>`, making the reviews path explicit.

**Rating chip** — `★ 4.5 · 12` becomes a link to the same skill page (it reads
as a reviews summary, so it navigates there). Name link unchanged.

**Layout** — `.ex-skillcard-actions` gets `flex-wrap: wrap` so three actions
wrap gracefully on narrow cards instead of shrinking.

**Icons live in `src/icons.tsx`** — three tiny components (`IconEye`,
`IconGitHub`, `IconComment`), matching the repo's existing hand-rolled-SVG
pattern (`Sparkline.tsx`); no icon dependency added.

## Alternatives considered

- **Icon-only buttons with tooltips** — tidier but less discoverable; rejected.
- **Whole card clickable** — solves reviews discoverability but is a larger
  interaction change with nested-anchor pitfalls; rejected for now.

## Testing

Extend `PopularSkills.test.tsx`: Reviews action links to `/skill/...`; rating
chip links to `/skill/...`; Preview button still opens the modal; GitHub link
href unchanged. Visual check via local server + browser screenshots.
