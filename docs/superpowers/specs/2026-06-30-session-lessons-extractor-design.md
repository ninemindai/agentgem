# Session Lessons Extractor (Gem Contributions #2) — Design

**Date:** 2026-06-30
**Status:** Approved-pending-review — second subsystem of [Gem Contributions vision](2026-06-30-gem-contributions-vision-design.md)

## Goal

Make the shipped **"✦ Distill this session"** flow yield **wins + lessons**, not just skills. A meaningful single session (a troubleshooting / devops / hard-fix session) is distilled by an LLM into both `DistilledSkill[]` (the procedure that worked — already shipped) and **`DistilledLesson[]`** (the durable, non-obvious lessons — *what was hard, what to remember, what bit you*). Lessons are **friction-seeded**: the LLM first names the session's friction, then enriches it into a reusable lesson.

## Context (what's already shipped)

A concurrent "Insights/Inspect" effort already built most of the session surface:
- **`POST /api/inspect/distill`** (`src/gem.controller.ts:301`) — `resolveClaudeSession` → `scanWorkflow([one transcript])` → `distillWorkflow` → `{ distilled: DistilledSkill[], degraded }`. **Skills only.**
- **TranscriptViewer "✦ Distill this session" CTA** — calls the endpoint, renders draft skills, saves via `POST /api/workflow/draft`.
- **`judgeSessions`** (`judgeSession.ts`) — batched ACP judge → `SessionFacet{ underlying_goal, outcome, friction_detail }`; powers the Insights panel.
- **#1 lessons plumbing** (shipped): `DistilledLesson`, `lessonToArtifact`, `writeDistilledLesson`, `stageLessonsByEvidence`, `POST /api/workflow/lesson`.

**Why the obvious wiring fails:** `extractReflections → reflectionsToLessons` is **recurrence-gated** — `recurring-pattern` needs `≥3` sessions (`extract.ts:168`) and `unresolved-task` is dropped by `reflectionToLesson`. On a **single** session every procedure has `sessions:1`, so that path yields **always `[]`**. Single-session lessons require an **LLM** reading the session — they cannot come from the recurrence heuristic. This is the spec's *salience-not-recurrence* principle.

## Decisions (settled in brainstorming)

1. **Source = LLM, friction-seeded, single ACP call.** A new `distillSessionLessons` pass mirrors `distillWorkflow` (same `connectFn`/`CLAUDE_AGENT`/plan-mode/timeout/degrade seam). Its prompt is friction-centered: *identify what was hard in this session, then distill the durable lesson(s) from it.* Friction is the seed and the enrichment happen in **one** call — no separate `judgeSessions` round-trip (the on-demand inspect path has no precomputed facet, and 3 agent calls per click is too heavy).
2. **Provenance is server-attached, never LLM-supplied.** The LLM returns only `{ body, importance }` per lesson; the server attaches `evidence: { sessions: 1, root, provenance }` from the single session (coordinates-only). This mirrors how `validateDistilled` backfills provenance from the signal — integrity + privacy.
3. **Degrade = empty, not heuristic.** If the agent errors/times out, return `{ lessons: [], degraded: true }`. There is no deterministic single-session lesson fallback (by decision 1's premise), so empty is the honest result. Never throws.
4. **Privacy boundary unchanged.** The prompt receives only what the scrubbed `WorkflowSignal` already carries for this session — the mission hint (`task`, `outcome`) + the scrubbed action spine — never raw transcript text. The returned lesson `body` is re-scrubbed (`sanitizeShareText`/`scrubText`) before it becomes an artifact (defense in depth).

## Architecture & data flow

```
POST /api/inspect/distill  (extended)
  resolveClaudeSession(id) → { path, cwd }
  signal = scanWorkflow([path], scanInv, {retainSequences:true})
  ── Promise.all ──
  │  distillWorkflow(signal, scanInv)        → skills   (existing)
  │  distillSessionLessons(signal, scanInv)  → lessons  (NEW)
  └─→ { distilled: skills, lessons, degraded: skillsDegraded || lessonsDegraded }

distillSessionLessons(signal, scanInv, opts):
  session = signal.sequences.sessions[0]      // the one session
  if no missionHint → { lessons: [], degraded: false }   // nothing to distill, agent not invoked
  spine = session.steps.map(s => s.verb)      // scrubbed verb spine (built inline; no actionSpine export)
  prompt = SESSION_LESSONS(missionHint, spine)   // friction-seeded
  text = ACP Claude (plan mode) promptText(prompt)            // same seam as distillWorkflow
  lessons = validateSessionLessons(text, session, root)        // parse + scrub + attach provenance
  → { lessons, degraded:false }  | on error → { lessons: [], degraded: true }
```

**Viewer:** the existing `DraftCard` skills list gets a sibling **lessons** list — each lesson shows `name`, `importance`, `body`; a **"Save lesson"** button calls the shipped `POST /api/workflow/lesson`. Mirrors the skills save flow. Claude-only (same gate).

## Components (files)

- **`packages/insight/src/sessionLessons.ts`** (new) — `distillSessionLessons(signal, scanInv, opts): Promise<{ lessons: DistilledLesson[]; degraded: boolean }>`, the `SESSION_LESSONS` prompt, and `validateSessionLessons(raw, session, root): DistilledLesson[]`. Imports the ACP seam from `acpRecommender.js` (`CLAUDE_AGENT`, `analysisWorkspace`, `currentTestConnectFn`, `defaultConnectFn`, `AcpConnectFn`) exactly as `distill.ts`/`judgeSession.ts` do, plus a local `extractJson` helper (a private per-module copy — the established pattern in `distill.ts`/`facets.ts`/`acpRecommender.ts`, not shared). Reuses `lessonSlug` (`distillTypes.js`) for names and `sanitizeShareText`/`scrubText` (`scrub.js`) for the body. Re-exported via `packages/insight/src/index.ts`.
- **`src/gem.controller.ts`** — extend `InspectDistillResponseSchema` with `lessons: z.array(DistilledLessonSchema)`; in `inspectDistill`, `Promise.all([distillWorkflow(...), distillSessionLessons(...)])` and return `lessons`; import `distillSessionLessons`.
- **`packages/console/src/panels/Observe/TranscriptViewer.tsx`** — render the `lessons` from the distill response + a "Save lesson" CTA (`POST /api/workflow/lesson`), beside the existing skills cards.

## Validation (`validateSessionLessons`)

- Parse `{ lessons: [{ body, importance }] }` from the agent text (tolerant: locate the JSON object, like `validateDistilled`); non-JSON → `[]`.
- Per lesson: `body` must be a non-empty string → re-scrub via `sanitizeShareText`; `importance` ∈ `{high, medium}` (default `medium` if missing/invalid); `name = lessonSlug(body)` (reuse the shipped slugger), de-duplicate names (`-2`, `-3`).
- Attach `status: "draft"`, `evidence: { sessions: 1, root, provenance }` where `provenance.occurrences` is built from the single session (its `sessionId`, transcript basename, the step `msgIndex`es) — coordinates only.

## Testing

- **`distillSessionLessons`** (stub `connectFn` via `currentTestConnectFn`, like the distill tests): a session with a mission hint → agent returns lessons JSON → typed `DistilledLesson[]` with server-attached provenance + scrubbed body; agent error → `{ lessons: [], degraded: true }`; no mission hint → `{ lessons: [], degraded: false }` (agent not invoked); malformed JSON → `[]`; name de-dup on colliding slugs; **privacy:** a body the agent returns containing a secret/`/Users/<name>/` path is scrubbed; provenance carries no body text.
- **`inspectDistill` wiring** — the response now includes `lessons` (shape/round-trip; the existing skills assertions unchanged).
- **TranscriptViewer** — renders lessons from a stubbed distill response and "Save lesson" POSTs to `/api/workflow/lesson` (update the existing test's mock to include `lessons`).
- Gates: root `pnpm test` (build console first — `pnpm build`); `pnpm --filter @agentgem/console test|typecheck`.

## Out of scope

- Wiring lessons into `/api/workflow/analyze` (the multi-session path) — separate; analyze already has reflections, and recurrence-lessons there are the #1 story.
- Codex sessions (the distill CTA is Claude-only).
- Auto-ranking / the Insights `publish_candidates` → distill bridge (already exists; this only enriches the per-session distill output).
- The `GEM_TYPES`/`cut:"playbook"` label (#3).

## Risks

- **Thin signal:** lessons are distilled only from the scrubbed mission hint + action spine (the privacy boundary), not the full transcript — so lesson quality is bounded by what the signal carries. Acceptable for v1; richer (still-scrubbed) context is a later enhancement.
- **Agent dependency / latency:** adds one ACP call in parallel with the existing skills call (no extra round-trips beyond that). Degrades to empty lessons, so the skills path is never blocked.
- **Hot file:** `src/gem.controller.ts` + `TranscriptViewer.tsx` are being actively moved by the concurrent Inspect effort — branch off the latest `origin/main`, keep the diff surgical, and integrate promptly.
