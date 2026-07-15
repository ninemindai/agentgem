# Studio publish toolbar declutter — design

**Date:** 2026-07-15
**Status:** approved (design-reviewed via /plan-design-review; layout variant C approved)
**Scope:** `packages/console` — Play Studio head row (`src/panels/Play/Studio.tsx`, `src/shell/theme.css`)

## Problem

The Studio head row holds 8 controls of mixed weight: Save, (Stop), Push to git, a
tags text input, three Public/Unlisted/Private visibility pills, "Share to
app.agentgem.ai", and Request review. Two of them render as red primaries at once
(the selected visibility pill and the Share button), and per-publish *settings*
(tags, visibility) sit alongside always-relevant *actions*. The row is crowded.

## Decision (user-approved)

1. **Move the visibility choice and the tags input out of the toolbar and into the
   share flow** — into the existing cover-confirm banner that every share already
   pauses at ("Use this as the share card cover?").
2. **Rename the Share button to one word: `Share`**, keeping `play-btn--primary`.
   The full destination survives as `title="Share to app.agentgem.ai"`; the
   success banner already reads "Published to app.agentgem.ai".

Toolbar after: `← Arcade · title · genre pill · status · Save · (Stop) · Push to
git · Share · Request review`. No settings in the row.

## Why the cover-confirm banner

The share flow is: `shareToExplore()` → save → screenshot capture → **cover-confirm
banner (always pauses, `coverStage === "confirm"`)** → `proceedToPublish()` →
identity gate → `checkAndPublish()` → optional version-conflict banner →
`publishWorkspace(login, version, scope)`.

- `scope` is read only late (`checkAndPublish` and the version-conflict banner
  buttons), and `tags` only inside `publishWorkspace` — both **after** the banner
  resolves. Moving the JSX therefore requires **no logic or flow changes**; the
  `useState` hooks stay where they are.
- The banner is the moment of sharing, which is the right moment to decide
  per-publish settings. Zero extra clicks versus today.
- Alternatives considered and rejected: a dropdown/split Share button (adds a click
  and a new popover component); a full publish modal (biggest redesign, not needed).

## Banner layout (approved variant C — "settings footer row")

Two rows inside the banner, so each row has one job. Cover decision first,
publish settings second, actions stay top-right:

```
🖼️ [cover img]  Use this as the share card cover?        [Use this] [Re-capture] [Upload] [Skip]
                Captured from the preview — swap it for your own image, or skip…
────────────────────────────────────────────────────────────────────── (hairline, --line)
VISIBILITY  [ Public | Unlisted | Private ]   helper line…        TAGS [tags, comma separated]
```

Wireframe reference: `~/.gstack/projects/ninemindai-agentgem/designs/studio-share-banner-20260715/banner-wireframes.html` (variant C; `approved.json` alongside).

- **Segmented control, not loose pills.** The three visibility options render as a
  joined segmented control (`.play-seg`): one bordered group, hairline separators,
  the selected segment filled **ink** (`var(--ink)` bg, `var(--raised)` text) —
  deliberately NOT `play-btn--primary`, so **"Use this" is the banner's only
  terracotta primary**. This kills the two-competing-primaries problem instead of
  relocating it from the toolbar.
- **Visible group labels.** Small uppercase muted labels `VISIBILITY` and `TAGS`
  precede their controls (11px, `--muted`, letter-spacing). This also fixes the
  tags field's placeholder-as-label violation — the placeholder stays as format
  hint, the label carries the name.
- **Helper line (user-approved copy, destination-focused):** one 11.5px `--muted`
  line after the segmented control, swapping with the selection:
  - Public — "Listed in Explore — anyone can find and play it."
  - Unlisted — "Anyone with the link can play; not listed in Explore."
  - Private — "Only you — lives in My apps."
- **Structure:** the footer row is a `flex-basis: 100%` child of the banner
  (banner gets `flex-wrap: wrap`), separated by a `border-top: 1px solid
  var(--line)` hairline. Tags group is pushed right with a flex spacer.
- **CSS:** new rules in `src/shell/theme.css` for `.play-banner__opts` (footer
  row), `.play-seg` (+ segment/selected states), and `.play-banner__opts-label`.
  Every new className gets a matching rule (project rule). Reuse
  `.play-tags-input` for the input.

## Accessibility & responsive (user-approved)

- **Semantics:** the segmented control keeps `role="radiogroup"`
  `aria-label="Sharing scope"` on the group and `aria-pressed` on each segment —
  identical to today's pills, so tests and screen-reader behavior carry over.
- **Focus:** segments get an explicit `:focus-visible` ring
  (`outline: 2px solid var(--accent); outline-offset: -2px`) — the joined control
  can't rely on `play-btn` border hover cues.
- **Announcements:** the helper line is `aria-live="polite"` so selection changes
  are read out with their meaning.
- **Wrap behavior at narrow widths:** the footer row wraps in this order — helper
  line drops under the segmented control first, then the tags group takes its own
  line (flex-wrap on the footer row; tags group `margin-left: auto` only when on
  the same line). No horizontal scrolling.

## Non-goals / unaffected surfaces

- **Request review** never passes through the cover banner and does not consume
  tags or visibility (its modal collects group + description) — nothing is lost.
- The version-conflict banner (`pendingVersion`) still publishes with `scope`; the
  value was chosen in the cover banner one step earlier.
- Default visibility stays `"public"`.
- No server/API changes; no marketplace changes.

## NOT in scope (considered, deferred)

- **Dropdown/split Share button** — rejected: extra click + new popover component.
- **Full publish modal** — rejected: biggest redesign; the banner already pauses
  the flow at the right moment.
- **Moving the Stop button or Push to git** — actions, they stay in the row.
- **Mobile/touch layout** — the console is a desktop Electron app; wrap behavior
  above covers narrow windows, no touch-target work.
- **DESIGN.md authoring** — no design system doc exists; `theme.css` tokens serve
  as the de-facto system. Flagged during review; not this change's job.

## What already exists (reuse, don't reinvent)

- `.play-btn` / `--ghost` / `--primary` button system and `--ink`/`--paper`/
  `--accent`/`--line` tokens in `src/shell/theme.css`.
- `.play-tags-input` and the banner skeleton (`.play-banner`, `__ico`, `__body`,
  `__title`, `__detail`).
- The banner's existing states, all inherited unchanged: capture-failed copy,
  too-large cover note, Re-capture busy state, identity-gate banner,
  version-conflict banner, success banner with per-visibility message.
- Prior learning `share-result-strip-non-card`: console toolbars can't host rich
  share UI inline — consistent with moving settings out of the row.

## Trade-off accepted

Visibility is no longer glanceable before clicking Share. It is instead set at
share time, per publish, which the user accepted as the right moment. The banner
gets ~1 row taller; hierarchy is the win that pays for it.

## Testing

- Update `src/panels/Play/__tests__/StudioShare.test.tsx`: assertions that locate
  the visibility pills / tags input in the toolbar move to locating them inside the
  `coverStage === "confirm"` banner; the button query for
  `Share to app.agentgem.ai` becomes `Share` (accessible name), with the tooltip
  title asserted. Add: helper line text swaps with selection; selected segment has
  `aria-pressed="true"`.
- Verify styled UI in a real browser (jsdom asserts behavior, not appearance):
  two-row banner composition, single terracotta primary, focus ring on segments,
  wrap order at a narrow window.

## Implementation Tasks

Synthesized from this review's findings. Each task derives from a specific
finding above. Run with Claude Code or Codex; checkbox as you ship.

- [ ] **T1 (P1, human: ~2h / CC: ~15min)** — console — Move tags input + visibility control into the cover-confirm banner as a settings footer row (variant C), rename Share button to "Share" with title tooltip
  - Surfaced by: Pass 1 Information Architecture — settings/actions mixed in toolbar; banner needs row-per-job hierarchy
  - Files: packages/console/src/panels/Play/Studio.tsx, packages/console/src/shell/theme.css
  - Verify: `pnpm --filter @agentgem/console test` + real-browser check of the banner
- [ ] **T2 (P1, human: ~1h / CC: ~10min)** — console — Segmented control `.play-seg` with ink-filled selected state (NOT play-btn--primary) + visible VISIBILITY/TAGS labels
  - Surfaced by: Pass 4 AI Slop / hard rules — two competing primaries; placeholder-as-label on tags
  - Files: packages/console/src/shell/theme.css, packages/console/src/panels/Play/Studio.tsx
  - Verify: banner shows exactly one terracotta button; tags field has a visible label
- [ ] **T3 (P1, human: ~30min / CC: ~5min)** — console — Visibility helper line with destination-focused copy, swapping with selection, `aria-live="polite"`
  - Surfaced by: Pass 2 Interaction States — helper copy unspecified (D6)
  - Files: packages/console/src/panels/Play/Studio.tsx, packages/console/src/shell/theme.css
  - Verify: StudioShare.test asserts helper text per selection
- [ ] **T4 (P2, human: ~30min / CC: ~5min)** — console — `:focus-visible` ring on segments + wrap-order CSS for the footer row
  - Surfaced by: Pass 6 Responsive & Accessibility (D7)
  - Files: packages/console/src/shell/theme.css
  - Verify: keyboard-tab through the banner in a real browser; resize to ~800px
- [ ] **T5 (P1, human: ~1h / CC: ~10min)** — console — Update StudioShare.test.tsx queries (banner-scoped pills/tags, "Share" name, aria-pressed assertions)
  - Surfaced by: Testing section — toolbar-scoped queries will break
  - Files: packages/console/src/panels/Play/__tests__/StudioShare.test.tsx
  - Verify: `pnpm --filter @agentgem/console test`

## Approved Mockups

| Screen/Section | Mockup Path | Direction | Notes |
|----------------|-------------|-----------|-------|
| Share banner (cover-confirm) | ~/.gstack/projects/ninemindai-agentgem/designs/studio-share-banner-20260715/banner-wireframes.html (variant C) | Two-row banner: cover decision + settings footer | Ink-selected segmented control; single terracotta primary; helper line; visible group labels. AI-image variants failed (OpenAI org verification); wireframe built from real theme.css tokens instead. |

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | — | — |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | CLEAN | score: 6/10 → 9/10, 4 decisions |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **VERDICT:** DESIGN CLEARED (banner layout variant C, helper copy, a11y specs, DESIGN.md TODO all resolved) — eng review required.

NO UNRESOLVED DECISIONS
