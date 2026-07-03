# `/learn` on a session — intent-driven distillation front door — design

- **Date:** 2026-07-03
- **Status:** Spec (awaiting user review)
- **Slice:** Part II phase (a) of [hermes-borrows](../../proposals/hermes-borrows.md)
- **Deferred with the console churn (PR #75 in flight):** the Curate "Distill this…"
  button; also deferred per the proposal: directory and URL sources (phases b/c).
- **Design deviations from the proposal (flagged for review):** the endpoint lives at
  `POST /api/dream/learn` (not `/api/distill/learn`) because its output *is* dream-queue
  entries and the queue endpoints live on the dream controller; results are tagged with a
  new queue phase `"LEARN"` so the review UI and diary can distinguish intent-driven
  finds from background harvests.

## Goal

Let a user point at a session and say "learn this, now." Today distillation is
recurrence-driven and retrospective (warm daemon + dreaming REM pass). This slice adds
the intent-driven front door: one command/endpoint that runs the existing extractor over
**one transcript** and lands candidates in the **existing review queue** — never
auto-accepting anything (the dreaming invariant).

Success criteria:

1. `agentgem learn <project-root>` distills the project's **most recent** Claude session
   and enqueues candidate skills/lessons into the dream review queue, printing what was
   queued; `--session <id>` targets a specific session.
2. `POST /api/dream/learn { root, dir?, session? }` does the same over HTTP and returns
   `{ session, enqueued, skills, lessons, degraded }`.
3. A `session` ref that doesn't match one of the project's known transcripts is rejected
   with `InvalidInputError` → 400 (input containment: the ref selects from a server-derived
   list, it is never used as a path).
4. Queue entries carry `phase: "LEARN"` and the same dedup keys as harvests — accepting
   or dismissing them uses the existing queue endpoints unchanged; a LEARN entry for
   evidence already reviewed does not resurface (same `enqueueNew` dedup).
5. A session with nothing distillable is a success, not an error: `enqueued: 0` / CLI
   prints "nothing distilled" and exits 0.

## Decisions and alternatives considered

**Reuse the pipeline on one transcript (chosen).** `scanWorkflow([path], scanInv,
{ retainSequences: true })` → `distillWorkflow` + `distillSessionLessons` → 
`harvestEntries` → `enqueueNew` — every stage exists and is tested. Alternatives
rejected: extending `computeDistill` with a session filter (its cache token is
project-scoped over *all* transcripts; a session-filtered result must not populate that
cache, so reuse buys nothing but coupling); a separate learn store (violates the
single-review-queue invariant — nothing lands without accept, in one place).

**No cache interaction.** `/learn` neither reads nor writes the distill cache: it scans
one file on demand (cheap) and its single-session results must not masquerade as the
project-wide distill. The dedup that matters (don't re-review the same evidence) already
lives in the queue keys.

**Claude sessions only in this slice** — `claudeTranscriptsForCwd` is the resolver;
other agents' sessions join when a real need appears (their transcripts already flow
into the background scan path).

**Honest single-session expectations.** The extractor's recurrence signal is weaker
within one session than across many; zero candidates is a legitimate outcome and is
reported as success (criterion 5), not padded with lowered thresholds.

## Components

### 1. Core — `src/learnCore.ts` (new)

```ts
export interface LearnResult {
  session: string;            // basename of the distilled transcript
  enqueued: number;           // entries actually added (post-dedup)
  skills: number;             // candidate skills found (pre-dedup)
  lessons: number;            // candidate lessons found (pre-dedup)
  degraded: boolean;          // LLM path unavailable → heuristic-only
}

export async function learnFromSession(opts: {
  root: string;               // project root (resolveProject applied)
  dir?: string;               // claude-home override (tests / non-default homes)
  session?: string;           // transcript basename or basename-without-.jsonl; default: newest
  now?: () => number;         // test seam
  distillWf?: typeof distillWorkflow;        // test seams, mirroring computeDistill's
  distillLessons?: typeof distillSessionLessons;
  base?: string;              // queue store home (test seam, default agentgemHome())
}): Promise<LearnResult>
```

Flow: `resolveDirs(dir)` + `resolveProject(root)` → `claudeTranscriptsForCwd` (empty →
`InvalidInputError("no sessions recorded for this project")`) → target = named match
(basename, `.jsonl` optional) or newest mtime → build `scanInv` exactly as
`computeDistill` does (`introspectProject` + `introspectConfig`) → scan/distill the one
path → `harvestEntries(root, skills, reflections, now)` with phase `"LEARN"` →
`enqueueNew`.

### 2. Queue phase — `src/dream/types.ts` + `src/dream/harvest.ts`

`DreamQueueEntry.phase` widens to `"DEEP" | "REM" | "LEARN"`. `harvestEntries` gains an
optional trailing `phase` parameter defaulting to `"DEEP"` (its two existing callers are
unchanged). Dedup keys already include the provenance hash — LEARN entries dedupe
against DEEP/REM entries for the same evidence, which is exactly right: if the
background pass already queued it, `/learn` reports it as not-newly-enqueued. The
Dreaming panel renders queue entries without branching on `phase` (only the status
strip's `phasesLit` is phase-aware), so no console change is required.

### 3. Endpoint — `POST /api/dream/learn` (`src/dream.controller.ts`)

Body `{ root: string, dir?: string, session?: string }`, response = `LearnResult`
(schemas in `src/schemas.ts`). Thin delegation to `learnFromSession`;
`InvalidInputError` → 400 via the established mapping. Colocated with
`/dream/queue/*` because its output is queue entries.

### 4. CLI — `agentgem learn` (`src/cli.ts` + `src/learnCli.ts` new)

`agentgem learn [root] [--session <id>] [--dir <claude-home>]` — root defaults to
`process.cwd()`. Follows the `verify` subcommand pattern (lazy import, injected-core
unit tests, exit codes: 0 success including nothing-distilled, 2 usage/containment
errors). Prints one line per enqueued entry (`+ skill "extract-api-client" queued`) and
a closing summary ("2 queued for review — Dreaming panel or /api/dream/queue").

## Data flow

```
root (+ optional session id)
  → claudeTranscriptsForCwd(claudeDir, root)     server-derived list
  → pick: named basename match | newest mtime    (no match → InvalidInputError)
  → scanWorkflow([one path]) → distillWorkflow + distillSessionLessons
  → harvestEntries(..., phase: "LEARN") → enqueueNew (dedup by key)
  → { session, enqueued, skills, lessons, degraded }
      → existing review flow: /dream/queue → accept | dismiss → diary
```

## Error handling

- Unknown project root → existing `resolveProject` behavior.
- No transcripts for the project → `InvalidInputError` (400 / exit 2).
- `session` ref not in the known list → `InvalidInputError` (400 / exit 2); the ref is
  compared against basenames, never joined into a path.
- Distiller degraded (no LLM) → heuristic-only result, `degraded: true`, still succeeds.
- Queue write failure → `enqueueNew` returns `[]` (existing contract); `enqueued: 0`
  with candidates > 0 is visible in the response rather than silently lost.

## Testing

Hermetic throughout (temp claude-home fixture with a synthetic project transcript, temp
`AGENTGEM_HOME` for the queue store, injected distill seams):

1. **Core:** most-recent selection (two transcripts, newer wins); named selection with
   and without `.jsonl`; unknown ref → `InvalidInputError`; entries land in the queue
   with `phase: "LEARN"` and correct kinds; re-learn of the same session enqueues 0
   (dedup); empty distill → `enqueued: 0`, no throw.
2. **Endpoint:** supertest — 200 happy path; 400 unknown session; schema round-trip.
3. **CLI:** injected-core unit tests — output lines, exit 0 on nothing-distilled,
   exit 2 on unknown session/usage.
4. Existing dream tests stay green (phase widening is additive; `harvestEntries`
   default preserves current behavior).
5. Full root suite + console tests (no console changes expected).

## Out of scope (later slices)

Directory and URL sources (need the SSRF-guard reuse review), the Curate
"Distill this…" button (post-#75 console slice), cross-agent session sources, `/journey`
aggregation endpoint, any auto-accept path (never).
