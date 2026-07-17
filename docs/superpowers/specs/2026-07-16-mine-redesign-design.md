# Mine Redesign — Design

**Date:** 2026-07-16
**Status:** Approved via brainstorm (visual companion, 2026-07-16). Scope: all three tiers, phased into 3 PRs.
**Panel:** `packages/console/src/panels/Mine/`

## Problem

Mine's hero is a **dummy card**: `Scorecard.tsx:54` renders a static SVG "certificate" of three counts (`N reusable workflows · N battle-tested · N worth sharing`). It's a share graphic, not a working surface — you can't open, run, compare, or act on the actual gems from it. Four things are wrong (all confirmed by the user):

1. **Counts, not gems** — the card summarizes; it never shows *which* workflows/skills you have.
2. **No perspective switching** — two fixed tabs (Workflows / Outcomes); no way to view the goldmine through different lenses.
3. **Unclear what gets mined** — the contents and their provenance aren't legible.
4. **Looks unfinished** — reads as a placeholder.

## Validated UX (from the brainstorm mockups)

Mine becomes a **single working surface** over the goldmine, not a certificate:

- **Scope bar (kept):** the project selector + the rubric-run shortcut already there (`Mine/index.tsx:22-37`).
- **Perspective switcher — "Group by": `Value · Type · Maturity`.** A segmented control that re-groups the same gem set without leaving the page. Remembers the last choice. **Default = Value.**
  - **Value:** `Battle-tested / Worth sharing / Gaps` — what's reliable or shareable.
  - **Type:** `Workflows / Skills / Lessons / Rubrics / Miniapps` — what each thing is.
  - **Maturity:** `Raw (in sessions) → Distilled (gems) → Shared` — the goldmine funnel.
- **Filter chips** (secondary, cross-cutting): All / Battle-tested / Worth sharing / Gaps.
- **Real gem cards** replace the certificate. Each card: **icon · name · provenance ("distilled from 4 sessions · react-app") · rubric score · badges (battle-tested / portable / shared) · three actions (Open · Distill→Gem *or* Re-evaluate · Share).**
- **Live rubric layer (the "connect to background jobs" idea):**
  - Each card headlines its **latest rubric score** (a number, green/amber), or a "…re-scoring" state while a background job runs.
  - A **jobs strip** at the top of the panel shows running rubric evaluations ("Re-scoring 3 skills against skill-effectiveness… 2 of 3 · view queue"), Mine-scoped.
  - A **Re-evaluate** card action kicks a background rubric job for that gem.
- **Share stays a per-item action** (mint a hosted gem/certificate link), not the whole panel's purpose.

The Outcomes view (LLM-judged report) stays as a distinct surface; this redesign is the Workflows/goldmine half.

## Data reality (what exists vs. new work)

Grounded against the backend (scorecard core, inventory, rubric compute):

| The UX wants | Backing data today | Verdict |
|---|---|---|
| Real workflow cards, **Value grouping** (battle-tested/worth-sharing/gaps) | `Scorecard` already computes `confidence:"high"` (battle-tested), `portable` (worth sharing), `gaps[]`, per-project, with `WorkflowDetail` (description/triggers/tools/steps/sessions) | **Exists** — UI over existing data |
| **Unified cross-type list** (skills+lessons+rubrics+miniapps+workflows in one shape) + **Type/Maturity groupings** | Four separate silos: `/api/inventory` (skills/mcp/subagents/hooks/rubric-defs), `/api/workspaces` (built gem bundles), `/api/play/miniapps` (games), scorecard `workflows[]`. No shared identity, no merge layer. Lessons/drafts are write-only (no list-back route). | **New** — a normalization/merge layer + list-back routes |
| **Rubric score per gem** | `RubricScope` is `session \| project \| all` ONLY (`rubricCore.ts:31-35`); the rubric cache key has **zero artifact-identity dimension**; compute evaluates a rubric against a *scope's transcript signal*, never against a specific artifact. Finest existing granularity is per-**session** (`HygieneLeaderboard`). | **New backend feature** — a new `artifact` rubric scope threaded through compute + cache key + controller schema + stream, plus a persistence index by artifact identity |
| **Live Mine-local jobs strip** | Raw plumbing exists: `ReportRegistry` (`report/registry.ts`, in-memory run records) + `GET /api/report/runs` + `ActivityProvider` 5s poll — but it's **global-footer chrome** today (`ActivityMenu` in `Shell.tsx`), not Mine-scoped, and can only show "a rubric run is happening," not "score X for gem Y" until per-artifact scoping exists. | **Partial** — re-scope the existing runs feed to a Mine-local strip |

Existing visual language to reuse: `.warming-pill` (background-work pill, `theme.css:148-167`), `.activity-*` (jobs dropdown, `theme.css:2051-2101`). All new classes go in the single `packages/console/src/shell/theme.css` (there is no per-panel CSS module pattern). **Note the token reality:** the console theme is the terracotta/paper palette (`--ink`/`--paper`/`--accent:#9a3324`/`--emerald`), NOT the dark blue/gem-gradient of the mockups — the mockups conveyed *structure*; the build uses the real tokens.

## Phased delivery (3 PRs)

Each PR ships value on its own; the switcher lands in PR-1 (Value only) and gains axes/scores as later PRs land.

### PR-1 — Kill the dummy card: real cards + Value grouping (mostly existing data)
- Remove the certificate hero as the centerpiece (keep a slim share affordance / move share to a per-item + a small "share my goldmine" secondary action).
- Render the scorecard's workflows as **real gem cards** (icon/name/provenance/badges/actions), grouped by **Value** (Battle-tested / Worth sharing / Gaps), with the filter chips.
- Land the **Group-by switcher** with Value selected and Type/Maturity present but disabled-with-tooltip ("coming soon") OR value-only until PR-2 — decide at plan time. Default = Value; remembers last choice (localStorage).
- All from existing `/api/scorecard/stream` + `/api/scorecard/workflow` data. No new server work.
- **Delivers:** Mine stops being a certificate; you see and act on real workflows through the Value lens.

### PR-2 — Unified gem list + Type/Maturity groupings (new merge layer)
- A server route (or client merge) that normalizes skills/subagents/rubric-defs (`/api/inventory`) + miniapps (`/api/play/miniapps`) + built gems (`/api/workspaces`) + scorecard workflows into one **`MineGem`** shape (id, type, name, provenance?, badges, maturity, share state).
- List-back routes for distilled lessons/skill drafts (`.agentgem/distilled/…`), currently write-only.
- Wire **Type** and **Maturity** groupings on the switcher over the unified list.
- **Delivers:** the full three-way switcher over everything you've mined, not just workflows.

### PR-3 — Per-gem rubric scores + live re-evaluate/jobs strip (new backend feature)
- New rubric scope kind `{kind:"artifact", type, name}` threaded through `RubricScope`/`scopeKey`/`rubricToken`/the controller + stream schemas.
- A persistence index of rubric results keyed by artifact identity (today's cache key has none).
- Per-card **score** + **Re-evaluate** (kicks a background rubric job); a **Mine-local jobs strip** re-scoped from the existing `/api/report/runs` feed (filtered to rubric runs for this scope).
- **Delivers:** the living, re-scorable goldmine — the "connect to background jobs" vision, fully wired.

## NOT in scope

- Redesigning the **Outcomes** view (the LLM-judged insights report) — untouched.
- The OG/share **certificate SVG** (`card.ts`) stays as the *shareable* artifact; it just stops being the in-panel hero.
- New rubric *authoring* — PR-3 adds artifact-scoped *evaluation*, not new rubric definitions.
- Real-time push for the jobs strip — polling the existing `/api/report/runs` (as `ActivityProvider` does) is sufficient; no new SSE.

## What already exists (reused)

`MineWorkflows` list + expand/detail/share/build (`Workflows.tsx`) — the real-item rendering is largely there; PR-1 restyles it into cards + Value grouping and demotes the certificate hero. `openScorecardStream` SWR (`scorecardStream.ts`). The rubric-run shortcut (`rubricShortcuts.ts`). `ReportRegistry` + `/api/report/runs` + `ActivityProvider` (jobs plumbing). The share-mint hook (`useShareMint`). `theme.css` tokens + `.warming-pill`/`.activity-*` visual language.

## Open questions for the plan (PR-1)

1. Certificate hero: fully remove, or keep a collapsed "share my goldmine" button that still mints the counts card? (Recommend: keep share as a small secondary action; drop the big image.)
2. In PR-1, are Type/Maturity shown disabled ("coming soon") or hidden until PR-2? (Recommend: shown-disabled, so the switcher's intent is legible from day one.)
