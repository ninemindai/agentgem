# Lessons-as-Artifacts (Gem Contributions #1) — Design

**Date:** 2026-06-30
**Status:** Approved-pending-review — first subsystem of [Gem Contributions vision](2026-06-30-gem-contributions-vision-design.md)

## Goal

Give a user's **lessons** a path into a **Gem**, by turning a `Lesson` into an **instructions artifact** — the missing, *source-agnostic* leg that lets a **Playbook** carry both wins (distilled skills) and lessons (distilled instructions). A `Lesson` is a salient learning carrying provenance from *one or many* sessions — it does **not** assume recurrence. This subsystem builds the **plumbing** and wires the cheapest *source* (recurring reflections) to prove the loop end-to-end; the high-value **meaningful-single-session** source is subsystem #2, which emits `Lesson`s through this same seam. Server + model only; no UI (subsystem #5).

## Context

The distillation spine already turns transcripts into two signals (`POST /api/workflow/analyze`):

- **Distilled skills** → `DistilledSkill` → `distilledToArtifact()` → `SkillArtifact` (`source: "distilled-draft"`) → staged into the inventory (`stageDraftsByEvidence`) → foldable into a gem build. **This wins path works end-to-end.**
- **Reflections** → `Reflection { kind: "recurring-pattern" | "recurring-decision" | "unresolved-task"; detail (scrubbed); importance: "high"|"medium"; provenance }` → today only become `gaps` + a `reflectionStore` entry. **No artifact path. This is the gap.**

Relevant shapes (ground truth):
- `Reflection`, `DistilledSkill`, `Provenance`, `Occurrence` — `packages/insight/src/distillTypes.ts` (provenance is **coordinates only**: `sessionId`, transcript basename, message indices — never raw content).
- `InstructionsArtifact` round-trips as `{ type: "instructions"; name; content }` — `packages/archive/src/archive.ts` (`writeGemArchive`/`readGemArchive`: instructions carry only name + content).
- Skill draft helpers (the pattern to mirror) — `packages/capture/src/draftStage.ts` (`distilledSkillMarkdown`, `distilledToArtifact`, `writeDistilledDraft`, `stageDraftsByEvidence`, `stageDistilledDrafts`).
- Accept endpoint to mirror — `POST /api/workflow/draft` in `src/gem.controller.ts` (accepts a `DistilledSkill`, writes a reviewable draft); `DistilledSkillSchema` in `src/schemas.ts`.

## Decisions (settled)

1. **The plumbing is source-agnostic; `Lesson` does not assume recurrence.** A `Lesson` carries provenance from one or many sessions. *This subsystem* wires only the cheapest source — recurring reflections — to exercise the seam; the meaningful-single-session source (the real value) is subsystem #2 and emits `Lesson`s through the same `lessonToArtifact`/staging path.
2. **From the reflection source, only `recurring-pattern` + `recurring-decision` promote.** `unresolved-task` is a personal TODO/gap, not a reusable lesson — it stays gap-only. (A *source-level* filter, not a constraint on what a Lesson is.)
3. **A source promotes to a reviewable `DistilledLesson` draft, deterministically (in #1).** Promotion derives a kebab `name` (slugified leading words of the lesson detail, validated `[a-z0-9-]`, collision-suffixed) and a framed instructions `body`. #1 stays **heuristic-only**; #2's meaningful-session source brings the LLM prose (same `distill.ts`/`extract.ts` seam). The user can rename on accept.
4. **Lessons stage as instructions into the gem build**, mirroring how skill drafts stage — so `buildGem` (which resolves names against the in-memory inventory) includes them with no change to `buildGem` itself.

## Model & data flow

```
DistilledLesson { name, body, importance, status:"draft", provenance, evidence }   ← source-agnostic
   ↑ produced by a SOURCE (this subsystem wires the first one):
   │   reflectionToLesson(reflection)  — recurring-pattern | recurring-decision (free source; #1)
   │   [meaningful-session extractor   — subsystem #2, emits DistilledLesson through this same seam]
   └─ then, source-agnostic:
        ├─ lessonToArtifact()        → InstructionsArtifact { type:"instructions", name, content }
        ├─ distilledLessonMarkdown() → the instructions body (lesson + coordinates-only provenance footer)
        ├─ writeDistilledLesson()    → <agentgemHome>/.agentgem/distilled/lessons/<name>.md  (review/promote)
        └─ stageLessonsByEvidence()  → merge artifacts into inventory.instructions (per evidence.root)
```

Accept loop (mirrors the skill draft loop): `analyze` already returns `reflections`; a new **`POST /api/workflow/lesson`** accepts a `DistilledLesson` (re-validates the kebab name, defense-in-depth) and writes it via `writeDistilledLesson`. The existing build path that stages accepted skill drafts also stages accepted lessons, so a built gem carries `instructions` artifacts that `writeGemArchive` emits and `readGemArchive` round-trips.

## Components (files)

- **`packages/insight/src/distillTypes.ts`** — add `DistilledLesson` (parallel to `DistilledSkill`: `name`, `body`, `importance`, `status:"draft"`, `provenance`, `evidence`) and a pure `reflectionToLesson(reflection, opts?): DistilledLesson | null` (null for `unresolved-task`).
- **`packages/capture/src/draftStage.ts`** — add `distilledLessonMarkdown`, `lessonToArtifact`, `writeDistilledLesson`, `stageDistilledLessons`, `stageLessonsByEvidence` (mirror the skill functions; instructions land under `inventory.instructions`, project-scoped by `evidence.root` like skills).
- **`src/schemas.ts`** — add `DistilledLessonSchema` + the `workflow/lesson` request/response schemas (mirror `DistilledSkillSchema` / `WorkflowDraftWriteResponseSchema`).
- **`src/gem.controller.ts`** — add `POST /api/workflow/lesson`; in the build path that calls `stageDraftsByEvidence`, also stage accepted lessons.

*Verified:* `ConfigInventory` carries `instructions: InstructionsArtifact[]` at both top-level and per-project (`packages/model/src/types.ts:65,72`), symmetric to `skills` — so `stageDistilledLessons` merges into `inventory.instructions` exactly as `stageDistilledDrafts` merges into `inventory.skills`.

## Testing

- `reflectionToLesson`: `recurring-pattern`/`recurring-decision` → a `DistilledLesson` with a kebab name + provenance; `unresolved-task` → `null`.
- `lessonToArtifact`: yields a valid `InstructionsArtifact` (`type:"instructions"`, kebab name, content carries the lesson + a coordinates-only provenance footer, no raw content).
- `distilledLessonMarkdown`: shape (lesson body + provenance footer).
- `writeDistilledLesson`: writes `.agentgem/distilled/lessons/<name>.md`.
- `stageDistilledLessons`: merges into inventory instructions; no-op (same reference) when empty; project-root match vs top-level.
- Endpoint `POST /api/workflow/lesson`: rejects a non-kebab name (400), writes + returns the path.
- **Integration (the loop):** build a gem from an inventory carrying a staged lesson → the gem has an `instructions` artifact → `writeGemArchive` emits it → `readGemArchive` round-trips it (Playbook = skills + lessons in one gem).

## Out of scope (this subsystem)

- Any UI (console "accept as lesson" button / marketplace) — subsystem #5.
- The **meaningful-single-session** lesson source + its LLM distillation — subsystem #2 (emits `DistilledLesson` through this subsystem's seam).
- The `type:"playbook"` cut classification itself — subsystem #3 (`GEM_TYPES`). #1 only makes lessons *exist as artifacts*; a gem with distilled skills + lessons is already buildable/shareable without a formal cut label.

## Risks

- **Privacy:** lesson `content` must carry only the scrubbed `detail` + coordinates-only provenance — never raw transcript text. Enforced by sourcing solely from `Reflection.detail` (already scrubbed) + `Provenance` (coordinates).
- **Name derivation collisions:** two reflections slugging to the same name — resolved by collision-suffixing and kebab re-validation at the accept endpoint.
- **Build-path staging site:** the one integration risk is wiring lesson staging into the *same* build path that stages skill drafts (so a built gem actually includes accepted lessons) — the plan must locate every `stageDraftsByEvidence` call site and add the symmetric lesson staging, not just add the helper.
