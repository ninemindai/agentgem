# Insights → Playbook → Explore (Contribute flow)

**Date:** 2026-06-30
**Status:** Design — ready for implementation plan
**Parent vision:** `2026-06-30-gem-contributions-vision-design.md` (this is the first vertical slice of that program)

## Goal

Turn the Insights report into a flywheel entry point: from a project the report
flags as worth publishing, let a signed-in user **contribute a 📓 Playbook Gem
(distilled wins + lessons) to the explore catalog/DB** — *and* get a social
share link — with a **review/edit step** before anything goes public.

This is the first turn of the contributions flywheel (usage → distilled
artifacts → discovery), wiring pieces that already exist rather than inventing
new machinery.

## Context — what exists (reuse), what's new

**Reuse (already on main):**
- **Distillation** — `distillWorkflow` (recurring wins → skill artifacts) and
  `distillSessionLessons` (lessons → instructions artifacts), wired in
  `gem.controller.ts`. Provenance is **coordinates-only** (no raw transcript
  content) — the privacy guarantee.
- **Gem types (Cut)** — `GemTypeRegistry` (`deriveCut`/explicit) with the
  built-in **Playbook** cut (`source: distilled-*`, has provenance).
- **Registry publish** — `POST /api/registry/publish` (the GitHub-backed
  registry that the explore `publicCatalog` reads). Currently **account-agnostic**
  (`scope` is caller-supplied).
- **Curate** — the artifact review/select surface; the Insights report already
  bridges to it via the `pendingAnalyze` hand-off + "Build a Gem from this project".
- **Social share** — `share.controller` (`/share/:id`), with a `gem` card kind
  (text-only teaser, no raw content).

**New (this slice):**
1. An orchestration that, for a project, produces a **Playbook draft**: distilled
   skills + lessons → a Gem typed Playbook.
2. A **review/edit** pass over that draft (reuse Curate's review surface).
3. A **publish step** that registry-publishes the reviewed Playbook **and** mints
   a `/share/:id` card — one combined action.
4. The **Insights report UI**: a "Contribute to explore" button in the "Worth
   publishing" section that starts the flow.

## Flow

```
Insights report ("Worth publishing")
  └─[Contribute to explore]→  distill project → Playbook draft (skills + lessons, cut=Playbook)
        └→ Curate review/edit (artifacts the user confirms; coordinates-only)
              └→ Publish:  registry-publish (→ explore catalog)  +  mint /share/:id card
                    └→ result: explore listing + shareable link
```

The Insights *facets* (per-session goals/outcomes/friction) are **not** published —
they only establish *which project is worth it*. The published content is the
distilled, generalized artifacts (coordinates-only provenance).

## Components (each independently testable)

- **`buildPlaybookDraft(root)`** (insight/capture seam) — runs the existing
  distill + lessons distill for a project root and assembles a Playbook-typed Gem
  draft (skills + instructions artifacts). Pure orchestration over existing
  functions; returns the draft + provenance. Degrade-safe (mirrors distill flow).
- **Review** — reuse Curate as the review/edit surface (no new review UI). The
  *hand-off* is the main integration point for the plan: the existing
  `pendingAnalyze` carries only a project root (→ Curate re-analyzes for artifact
  *selection*), but a Playbook also needs the distilled **lessons** (instructions).
  Two candidate shapes for the plan to pick: (a) extend the hand-off to carry the
  pre-built Playbook draft (skills + lessons + `cut`) that Curate renders for
  review, or (b) extend Curate's Analyze to also surface lessons and the Playbook
  draft. (a) keeps the distill in one place and is preferred; the plan confirms.
- **`publishPlaybook` endpoint** — given the reviewed selection + cut + name,
  (a) registry-publish (existing path, scope = signed-in account's, interim) and
  (b) create a `share` card; returns `{ exploreRef, shareUrl }`. One endpoint =
  one combined action.
- **Insights panel button** — "Contribute to explore" in `InsightsReportCard`'s
  "Worth publishing" block (next to "Build a Gem from this project"); kicks off
  `buildPlaybookDraft` → routes to Curate.

## Decisions (resolved)

- **Review/edit step: yes** — the distilled artifacts are LLM-generated; public
  quality matters. Reuse Curate rather than build a new review surface.
- **Publishing: use the existing account-agnostic registry publish** for this
  slice; **account-bound publishing (vision #4)** is a fast-follow (scope to the
  signed-in account, `@you/*`). Flag in the UI that the published scope is interim.
- **One combined button** — "Contribute to explore" both registry-publishes and
  mints the social card; the result surfaces both the explore listing and the
  share link. (Open to splitting if review says otherwise.)

## Privacy

Only distilled artifacts with **coordinates-only provenance** publish — never raw
transcript content, goals, or friction prose. The social card is a teaser (gem
kind), no content. This inherits the existing distill privacy model; no new
exposure surface.

## Testing

- `buildPlaybookDraft` — unit: a project signal with distillable wins+lessons
  yields a Playbook-cut draft with both artifact kinds; degrade-safe when distill
  fails (empty/partial draft, never throws).
- `publishPlaybook` — unit (injected deps): publishes via the registry path AND
  creates a share card; returns both refs; an explicit `cut=Playbook`.
- Insights panel — render test: the "Contribute to explore" button appears in the
  Worth-publishing block and triggers the hand-off.
- No live registry/network in tests (inject the publish + share deps).

## Deferred / non-goals

- Account-bound publishing (vision #4) — fast-follow; this slice uses existing publish.
- The faceted explore browse UI (Cut × Stone rendering, vision #5).
- Crowd-earned ratings / Diamond seal (needs adoption telemetry).
- Other cuts as Insights sources (this slice is Playbook only).
