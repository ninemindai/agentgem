# Lessons-as-Artifacts (Gem Contributions #1) — Design

**Date:** 2026-06-30
**Status:** Approved-pending-review — first subsystem of [Gem Contributions vision](2026-06-30-gem-contributions-vision-design.md)

## Goal

Give distilled **reflections** (a user's *lessons*) a path into a **Gem**, by turning a reflection into an **instructions artifact** — the missing leg that lets a **Playbook** carry both wins (distilled skills) and lessons (distilled instructions). Server + model only; no UI (that is subsystem #4).

## Context

The distillation spine already turns transcripts into two signals (`POST /api/workflow/analyze`):

- **Distilled skills** → `DistilledSkill` → `distilledToArtifact()` → `SkillArtifact` (`source: "distilled-draft"`) → staged into the inventory (`stageDraftsByEvidence`) → foldable into a gem build. **This wins path works end-to-end.**
- **Reflections** → `Reflection { kind: "recurring-pattern" | "recurring-decision" | "unresolved-task"; detail (scrubbed); importance: "high"|"medium"; provenance }` → today only become `gaps` + a `reflectionStore` entry. **No artifact path. This is the gap.**

Relevant shapes (ground truth):
- `Reflection`, `DistilledSkill`, `Provenance`, `Occurrence` — `packages/insight/src/distillTypes.ts` (provenance is **coordinates only**: `sessionId`, transcript basename, message indices — never raw content).
- `InstructionsArtifact` round-trips as `{ type: "instructions"; name; content }` — `packages/archive/src/archive.ts` (`writeGemArchive`/`readGemArchive`: instructions carry only name + content).
- Skill draft helpers (the pattern to mirror) — `packages/capture/src/draftStage.ts` (`distilledSkillMarkdown`, `distilledToArtifact`, `writeDistilledDraft`, `stageDraftsByEvidence`, `stageDistilledDrafts`).
- Accept endpoint to mirror — `POST /api/workflow/draft` in `src/gem.controller.ts` (accepts a `DistilledSkill`, writes a reviewable draft); `DistilledSkillSchema` in `src/schemas.ts`.

## Decisions (flag for review)

1. **Only `recurring-pattern` + `recurring-decision` are lesson-eligible.** `unresolved-task` is a personal TODO/gap, not a reusable lesson to share — it stays gap-only and is excluded from lesson promotion. *(Decision — confirm.)*
2. **A reflection promotes to a reviewable `DistilledLesson` draft, deterministically.** A reflection has no `name`; promotion derives a kebab `name` from `detail` (slugified leading words, validated `[a-z0-9-]`, collision-suffixed) and a framed instructions `body`. Start **heuristic-only** (no LLM) — same heuristic-first resilience as the distill seam; LLM prose enrichment is a later, optional concern. *(Decision — confirm the deterministic-first scope and the name-derivation rule; the user can rename on accept.)*
3. **Lessons stage as instructions into the gem build**, mirroring how skill drafts stage — so `buildGem` (which resolves names against the in-memory inventory) includes them with no change to `buildGem` itself.

## Model & data flow

```
Reflection (recurring-pattern | recurring-decision)
   └─ reflectionToLesson()  → DistilledLesson { name, body, importance, status:"draft", provenance, evidence }
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

- Any UI (console "accept as lesson" button / marketplace) — subsystem #4.
- LLM enrichment of lesson prose — start deterministic; enrich later behind the same seam the skill distiller uses.
- The `type:"playbook"` cut classification itself — subsystem #2 (`GEM_TYPES`). #1 only makes lessons *exist as artifacts*; a gem with distilled skills + lessons is already buildable/shareable without a formal cut label.

## Risks

- **Privacy:** lesson `content` must carry only the scrubbed `detail` + coordinates-only provenance — never raw transcript text. Enforced by sourcing solely from `Reflection.detail` (already scrubbed) + `Provenance` (coordinates).
- **Name derivation collisions:** two reflections slugging to the same name — resolved by collision-suffixing and kebab re-validation at the accept endpoint.
- **Build-path staging site:** the one integration risk is wiring lesson staging into the *same* build path that stages skill drafts (so a built gem actually includes accepted lessons) — the plan must locate every `stageDraftsByEvidence` call site and add the symmetric lesson staging, not just add the helper.
