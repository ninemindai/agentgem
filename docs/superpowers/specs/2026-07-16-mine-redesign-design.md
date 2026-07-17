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
- **Perspective switcher — "Group by": `Value · Type · Maturity`.** A segmented control that re-groups the same gem set. **Default = Value.** It is a **hash-routable sub-state of the Workflows view** (e.g. `#/mine?group=type`), not a panel-wide `localStorage` toggle — Mine already uses `useSubRouteTabs`, and a hidden localStorage grouping has no deep-link and silently changes what a returning visitor sees. (Eng review D2/codex.)
  - **Value:** `Battle-tested / Worth sharing / Gaps` — what's reliable or shareable.
  - **Type:** `Workflows / Skills / Lessons / Rubrics / Miniapps` — what each thing is.
  - **Maturity:** `Raw (in sessions) → Distilled (gems) → Shared` — the goldmine funnel.
- **Filter chips** (secondary, cross-cutting): All / Battle-tested / Worth sharing / Gaps. **When the active grouping IS `Value`, the chips collapse to just `All`** (design review) — the group headers already carry Battle-tested / Worth-sharing / Gaps, so rendering both is the same axis shouted twice. The chips earn their place only under the `Type` and `Maturity` groupings, where value is an orthogonal cross-cut.
- **Real gem cards** replace the certificate. Each card: **icon · name · provenance ("distilled from 4 sessions · react-app") · a headline signal · badges · type-appropriate actions.**
  - **The headline number is the signal that fits the card's type**, NOT one universal "rubric score" (which would blur distinct meanings into a fake metric): workflow → `confidence`/`portable`; built gem → `Gem.grade`/`scorecardFloor`; skill → effectiveness/benchmark; Curate-inventory item → usage (`invocations`/`lastUsedMs`).
  - **Actions vary by type** — a workflow (a *candidate*) offers Distill→Gem; an installed skill (an *artifact*) offers Open/Re-run-hygiene; a miniapp (a *runnable bundle*) offers Play; a lesson (a *draft*) offers Open. One card shape with the same three actions would produce nonsense actions across types.
- **Live rubric layer — realized with EXISTING rubric scopes (eng review D2), not a per-gem rubric primitive:**
  - The "live assessment" is **the Mine-local jobs strip** (running rubric evaluations) re-scoped from the existing `/api/report/runs` feed, plus **existing session/project rubric results surfaced against a gem's evidence** (a workflow carries its source `sessions`; a project-scoped hygiene run covers that project's gems).
  - A **"Run hygiene on this project/session"** action kicks an existing-scope rubric run; the strip reflects it. There is **no new `{kind:"artifact"}` rubric scope** — a rubric scores a transcript for `session|project|all`, and a static skill/miniapp is not a transcript.
- **Share stays a per-item action** (mint a hosted gem/certificate link), not the whole panel's purpose.

The Outcomes view (LLM-judged report) stays as a distinct surface; this redesign is the Workflows/goldmine half.

## Data reality (what exists vs. new work)

Grounded against the backend (scorecard core, inventory, rubric compute):

| The UX wants | Backing data today | Verdict |
|---|---|---|
| Real workflow cards, **Value grouping** (battle-tested/worth-sharing/gaps) | `Scorecard` already computes `confidence:"high"` (battle-tested), `portable` (worth sharing), `gaps[]`, per-project, with `WorkflowDetail` (description/triggers/tools/steps/sessions) | **Exists** — UI over existing data |
| **Unified cross-type list** (skills+lessons+rubrics+miniapps+workflows) + **Type/Maturity groupings** | Four separate silos with no shared identity/merge layer. **BUT** the Curate panel (`Curate/data.ts:28`) ALREADY builds a merge/read model over `/api/inventory` + `/api/usage` with grouping/filtering/lazy body-loading. Miniapps (`/api/play/miniapps`) and workflows need a detail fetch for provenance. Address schemes differ (`workspaceArtifactPath`/`entityPath` cover only skills/subagents/instructions). | **New, but REUSE Curate's read model** — extract Curate's inventory+usage merge rather than inventing a parallel `MineGem`; fix shared identity at the model boundary + a composed summary endpoint (avoid N+1) |
| **Card headline signal** ("how good is this gem") | Exists per-type already: workflow `confidence`/`portable`/`sessions`; built-gem `Gem.grade`/`scorecardFloor` (`gemGrade.ts:19`); Curate usage `invocations`/`lastUsedMs`; skill effectiveness/benchmark. | **Exists** — use the type-fitting signal; do NOT invent a universal rubric score (would duplicate/blur these) |
| **Live rubric layer** | `RubricScope` is `session \| project \| all` ONLY (`rubricCore.ts:31-35`) and evaluates a *transcript signal for a scope*, never an artifact — so a per-artifact rubric score is a **category error** for static skills/miniapps. Jobs plumbing exists (`ReportRegistry` + `GET /api/report/runs` + `ActivityProvider` 5s poll) but is global-footer chrome. | **Reframed (eng review D2)** — NO new artifact scope; surface EXISTING session/project rubric results against a gem's evidence sessions + re-scope the runs feed to a Mine-local jobs strip |

Existing visual language to reuse: `.warming-pill` (background-work pill, `theme.css:148-167`), `.activity-*` (jobs dropdown, `theme.css:2051-2101`). All new classes go in the single `packages/console/src/shell/theme.css` (there is no per-panel CSS module pattern). **Note the token reality:** the console theme is the terracotta/paper palette (`--ink`/`--paper`/`--accent:#9a3324`/`--emerald`), NOT the dark blue/gem-gradient of the mockups — the mockups conveyed *structure*; the build uses the real tokens. **Scale:** the scorecard is already capped at 12 projects × 12 workflows/project — a cross-type list + per-card signal must respect similar bounds and not fan out per-card fetches.

## Interaction states & design polish (design review 2026-07-16)

The mockups showed only populated, happy-path states. A working surface has to design the other states too — each one below reuses an existing console pattern, so this is spec detail, not new invention. All of these land **inside the PR that introduces the surface they describe** (empty/loading/card states in PR-1; unified-list states in PR-2; jobs-strip states in PR-3), not as a separate polish pass.

- **Empty / first-run state (was unspecified — the biggest gap).** A brand-new user, or a project with nothing mined yet, must NOT see a bare "Battle-tested (0)". Reuse the existing doorway pattern (`.ledger-empty-state` / `.getgems-empty` / `.obs-firstrun`, `theme.css:428` — "a doorway, not a dead end: title + context + a primary action"): title ("No gems mined here yet"), one line of context (what mining is / that it happens as you work), and a primary action (e.g. **Run a hygiene rubric** or **Open a recent session**). Per-group empty (a populated board where only *Gaps* is empty) just omits that group header — no "0" placeholders.
- **Loading state.** Initial `/api/scorecard/stream` warm can be slow (cold-build worker). Show card **skeletons** in the active grouping, not a blank panel or a spinner-only screen; reuse `.ledger-loading` (italic muted) for the group-header row. The per-card `…re-scoring` state (already in the mockup) covers in-flight rubric jobs, a different thing from first paint.
- **Error state.** If a scope's scorecard or a rubric run fails, show an inline, recoverable message (what failed + a Retry), never a silent empty board that reads as "you have no gems." Mirror how `Curate`/`Analyze` phrase their empty/degraded copy.
- **Card visual hierarchy (scan order).** Primary read = **name** (left, `--font-display` weight, the thing you scan for). Secondary = **provenance** (muted, one line). Tertiary supporting glance = the **headline signal** (right); size it to *support* the name, not fight it — the mockup's 17px right-aligned number competes with the name for first-read, so demote it a step. Badges sit under the name. This keeps "what can I rely on / act on" the first thing the eye lands on, not a number whose meaning varies by type.
- **Accessibility.** (1) The green/amber score color is currently the *only* good/bad signal — that fails colorblind users. Lean on the already-present text badges (`battle-tested` / `portable` / `gaps`) as the non-color carrier, and give the score a text label (`hygiene` / `effectiveness`) as the mockup does. (2) The Group-by segmented control needs roving-tabindex keyboard nav (arrow keys move, Enter selects) and `aria-pressed`; it drives a hash route, so it must be reachable without a mouse. (3) Actions are real buttons (44px min touch target), not click-styled spans.
- **Text overflow (the 47-char-name test).** Long gem names and long `distilled from N sessions · <project>` provenance must truncate with the console's standard `min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap` idiom, full text on `title`/hover — never wrap a card to double height or push the signal off-screen.
- **Responsive / narrow panel.** Mine is a console panel and the sidebar is resizable — a fixed 2-column grid cramps it. Use the existing `.play-grid` auto-fill pattern (`repeat(auto-fill, minmax(248px, 1fr))`) so cards reflow to a single column in a narrow rail with no media-query bookkeeping.
- **Jobs strip idle / layout shift.** When no rubric jobs are running the strip reserves **no** vertical space (collapse, mirroring how `.bg-status-empty` hides in the rail) so it appearing/disappearing on job start/finish doesn't jank the card grid below it.

## Phased delivery (3 PRs)

Each PR ships value on its own; the switcher lands in PR-1 (Value only) and gains axes/scores as later PRs land.

### PR-1 — Kill the dummy card: real cards + Value grouping (existing data only)
- Remove the certificate hero as the centerpiece; keep share as a per-item action + a small "share my goldmine" secondary button (recommend: drop the big image, keep the mint).
- Render the scorecard's workflows as **real gem cards** (icon/name/provenance/badges/actions), grouped by **Value** (Battle-tested / Worth sharing / Gaps), with the filter chips.
- Ship the **Group-by switcher with Value ONLY** — Type/Maturity are **not shown** until PR-2 (no dead/disabled tabs advertising a model the system can't satisfy yet — eng review D2/codex). The switcher's grouping is hash-routable (`#/mine?group=…`), not localStorage.
- All from existing `/api/scorecard/stream` + `/api/scorecard/workflow`. **No new server work.**
- **Ship the interaction states with the cards** (design review): the empty/first-run doorway, card skeletons on warm, inline error+retry, the name-primary hierarchy, the a11y cues (badge-as-non-color-signal, keyboard-navigable segmented control, real buttons), name/provenance truncation, and the `.play-grid` auto-fill responsive grid. These are not a later polish pass — an unstyled empty state is exactly the "looks unfinished" problem this PR exists to kill.
- **Delivers:** Mine stops being a certificate; you see and act on real workflows through the Value lens, in every state (empty, loading, error, populated). Highest-certainty win.

### PR-2 — Unified gem list + Type/Maturity groupings (extract Curate's read model)
- **Reuse, don't reinvent:** extract Curate's existing inventory+usage merge/read model (`Curate/data.ts`) into a shared read model both Curate and Mine consume, rather than a parallel `MineGem` ledger. Fix **shared identity at the server/model boundary first** (the address schemes differ across types) and expose a **composed summary endpoint** so a unified list doesn't N+1 per card (miniapps/workflows need provenance detail).
- Add list-back routes for distilled lessons/skill drafts (`.agentgem/distilled/…`, currently write-only).
- Cards stay **type-distinct** (candidate vs artifact vs bundle vs draft): the shared shape carries per-type headline signal + per-type actions, not one uniform card.
- Wire **Type** and **Maturity** groupings (now shown) over the unified read model, respecting the scale caps.
- **Delivers:** the full three-way switcher over everything you've mined, on a read model shared with Curate.

### PR-3 — Live rubric layer via EXISTING scopes (eng review D2 — no new rubric primitive)
- **No `{kind:"artifact"}` rubric scope.** Instead: surface **existing session/project rubric results against a gem's evidence** — a workflow's source `sessions`, a project-scoped hygiene run over that project's gems (`HygieneLeaderboard` already computes per-session scores).
- A **"Run hygiene on this project/session"** card/scope action kicks an existing-scope rubric run; a **Mine-local jobs strip** re-scoped from the existing `/api/report/runs` feed shows it running and refreshes on completion.
- The card headline stays the **type-fitting signal** (grade/confidence/effectiveness/usage) from PR-1/PR-2; the rubric layer adds evidence-linked hygiene context, not a new universal number.
- **Delivers:** the living, re-scorable board tied to real rubric runs — the "connect to background jobs" vision — without a semantically-empty per-artifact score.

## NOT in scope

- Redesigning the **Outcomes** view (the LLM-judged insights report) — untouched.
- The OG/share **certificate SVG** (`card.ts`) stays as the *shareable* artifact; it just stops being the in-panel hero.
- New rubric *authoring* — PR-3 adds artifact-scoped *evaluation*, not new rubric definitions.
- Real-time push for the jobs strip — polling the existing `/api/report/runs` (as `ActivityProvider` does) is sufficient; no new SSE.

## What already exists (reused)

`MineWorkflows` list + expand/detail/share/build (`Workflows.tsx`) — the real-item rendering is largely there; PR-1 restyles it into cards + Value grouping and demotes the certificate hero. `openScorecardStream` SWR (`scorecardStream.ts`). **Curate's inventory+usage merge/read model (`Curate/data.ts`)** — extracted and shared in PR-2 rather than reinvented. `Gem.grade`/`scorecardFloor` (`gemGrade.ts`) + workflow `confidence`/`portable` + Curate usage — the per-type headline signals. The rubric-run shortcut (`rubricShortcuts.ts`) + `HygieneLeaderboard` per-session scores. `ReportRegistry` + `/api/report/runs` + `ActivityProvider` (jobs plumbing, re-scoped to a Mine-local strip). The share-mint hook (`useShareMint`). `theme.css` tokens + `.warming-pill`/`.activity-*` visual language.

## Decisions from eng review (2026-07-16)

Resolved (were open questions / codex findings):
1. **Certificate hero:** drop the big image; keep share as a small per-item + "share my goldmine" secondary action.
2. **PR-1 switcher:** ship **Value-only** — Type/Maturity hidden until PR-2 (no dead tabs).
3. **Switcher state:** hash-routable (`#/mine?group=…`), not `localStorage` (no deep-link, silent-visit-drift).
4. **PR-2:** extract & reuse Curate's read model; fix identity at the model boundary; composed summary endpoint (no N+1); type-distinct cards.
5. **PR-3 (strong-take, user-confirmed):** realize the "live rubric" idea via **existing session/project scopes surfaced against a gem's evidence** + the Mine-local jobs strip — **no new per-artifact rubric primitive** (category error). Card headline = the type-fitting existing signal.

Resolved from design review (2026-07-16, all high-confidence, no user strong-take needed — each reuses an existing console pattern):
6. **Interaction states are in scope, per PR.** Empty/first-run doorway, loading skeletons, inline error+retry, idle jobs-strip — designed, not deferred (see Interaction states section). The empty state is the highest-leverage fix: it's the literal "looks unfinished" complaint.
7. **Value-grouping chip redundancy resolved.** Under `Group by = Value`, the filter chips collapse to `All` (group headers already carry that axis); chips only render under Type/Maturity.
8. **Card hierarchy = name-primary.** Name is the first read; the headline signal supports rather than competes (demoted from the mockup's 17px co-equal number).
9. **Responsive by construction.** Reuse `.play-grid` auto-fill (`minmax(248px,1fr)`) instead of a fixed 2-col grid, so the resizable sidebar/rail reflows to one column.
10. **Accessibility carried, not color-only.** Text badges + score label are the non-color good/bad signal; segmented control is keyboard-navigable (roving tabindex, `aria-pressed`); actions are real 44px buttons.

## GSTACK REVIEW REPORT

Two reviews ran against this spec under one goal ("review the spec using /plan-eng-review and /plan-design-review; accept recommendations unless not confident or needing a strong take").

| Review | Status | Findings (all adopted into the spec) |
|---|---|---|
| plan-eng-review (+ codex outside voice) | issues_found → resolved | 5 items: certificate hero demoted; PR-1 switcher Value-only (no dead tabs); switcher state hash-routable not localStorage; PR-2 reuse Curate's read model + composed endpoint (no N+1); **per-artifact rubric score is a category error** → reframed to existing session/project scopes surfaced against a gem's evidence (user-confirmed strong-take, Option B). |
| plan-design-review (designer's eye) | issues_found → resolved | 5 items: interaction states (empty/first-run doorway, loading skeletons, inline error+retry, idle jobs-strip) designed per-PR; Value-grouping vs value-chip redundancy collapsed; card hierarchy name-primary (signal demoted); responsive via `.play-grid` auto-fill; accessibility carried by text badges + keyboard-navigable segmented control, not color alone. |

Every design finding maps to an **existing console pattern** (`.ledger-empty-state`/`.getgems-empty` doorway, `.play-grid` auto-fill, the `min-width:0` ellipsis idiom), so adoption is spec detail, not new invention. No mockups regenerated — the direction was already validated in the brainstorm visual companion; the review's value was completeness (the states the mockups didn't show) and one IA de-duplication.

VERDICT: SHIP. Spec is design- and engineering-complete for a 3-PR phased build; the eng review's category-error catch (no per-artifact rubric primitive) and the design review's empty-state catch were the two load-bearing corrections. CODEX absorbed (eng review). CROSS-MODEL absorbed (eng review D2, user-confirmed Option B).

NO UNRESOLVED DECISIONS
