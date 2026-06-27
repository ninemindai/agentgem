# Distillation Extractor Seam — Design

**Date:** 2026-06-27
**Branch:** `feat/distill-extractor-seam`
**Status:** Design approved, ready for implementation plan

## Problem

Skill distillation (shipped on `main`, merge `4d370c2`) turns recurring
builtin-procedures in session transcripts into reusable draft SKILLs. The
pipeline is sound but has two structural gaps and two missing capabilities,
all surfaced by comparing it against OpenHuman's `transcript_ingest`
(`learning/transcript_ingest/extract.rs`), a heuristic-first transcript miner:

1. **Provenance is coarse.** A `DistilledSkill.evidence` carries only
   `{ sessions, exampleSequence, root }`. There is no session id, no message
   index, no timestamp — so the system cannot answer *"show me exactly where
   this skill came from."* OpenHuman stamps every candidate with
   `thread_id + transcript_basename + message_indices + extracted_at`. Fine
   provenance is the spine the trust/auditability thesis needs
   (see the AgentGem trust rubric: observability pillar).

2. **Distillation is LLM-or-nothing.** `distillWorkflow` requires the ACP/Claude
   call. When the agent is unavailable (no creds), times out, or returns junk,
   the result is `{ distilled: [], degraded: true }` — *zero* output. OpenHuman's
   extractor is heuristic-first by design and runs with no provider, with the
   LLM as an optional later layer "on the same trait surface."

3. **No precision pre-filter.** The Phase-0 gate (`distillCandidates`) filters on
   recurrence + spine length only. There is no content-aware ranking before LLM
   spend, so weak candidates (empty mission, minimum recurrence) consume tokens.

4. **One output stream.** The pipeline emits skill drafts only. Recurring
   signals that are *not* skill-worthy (unresolved tasks, sub-threshold habits)
   are discarded. OpenHuman keeps a second `conversation_reflections` stream.

This design closes all four by inserting **one deterministic extractor seam**
between mining and the LLM. The seam is where provenance is stamped, the
heuristic fallback is produced, precision filtering happens, and reflections are
emitted — so the four enhancements share one well-bounded, independently
testable module rather than being scattered across the pipeline.

> **Note on AgentGem's recurrence signal.** AgentGem's n-gram procedure mining
> (maximal frequent 3–6-grams, support ≥2) is *stronger* than OpenHuman's
> keyword-count recurrence, which conflates volume with recurrence. This design
> does **not** adopt OpenHuman's recurrence heuristic. It borrows only the
> *shape*: provenance discipline, heuristic-first/LLM-enricher split, high-precision
> deterministic filtering, and a second reflections stream.

## Decisions (from brainstorming)

- **Architecture: a new deterministic extractor seam** (`src/gem/extract.ts`),
  not in-place augmentation and not a parallel distiller. It reuses the existing
  `distillCandidates` Phase-0 gate unchanged, then enriches survivors. The LLM
  call (`distillWorkflow`) becomes an *enricher* over the seam's output.
- **All four enhancements are first-class deliverables**, architected around the
  shared seam.
- **LLM success trusts the LLM's selection.** When the LLM succeeds, skeletons
  are *not* kept for candidates the LLM dropped (it judged them junk). Skeletons
  ship only when the LLM degrades. *(Confirmed judgment call.)*
- **Reflections derive only from already-captured scan data** — no new mining
  pass. Cheap; bounded by what the procedure spine already shows.
  *(Confirmed judgment call.)*
- **New UI is deferred.** Per the planned React rewrite (UI is vanilla static
  HTML today; new UI builds wait for the rewrite, backend/CORS not blocked),
  provenance "jump to source" and the reflections panel are **specced but
  deferred**. Their *data* ships now in the API payload + sidecar.
- **The deterministic seam is the privacy/trust boundary.** The LLM never sees
  raw provenance; it is stitched back on after validation. Provenance carries
  **coordinates only** (session id, basename, message indices, timestamp) —
  never raw message content.

## Architecture & data flow

A new deterministic stage between *mine* and *LLM-distill*:

```
transcripts (JSONL)
   │
   ├─ scanWorkflow(retainSequences)            MODIFIED: emit provenance coords
   │     WorkflowSignal {
   │       sequences.sessions[]  (+ sessionId, + transcript, + atMs; steps + msgIndex)
   │       procedures[]          (+ sessionIdxs: all exercising sessions)
   │     }
   │
   ├─ extractCandidates(signal, inv)           NEW SEAM (pure, fully testable)
   │     ├─ distillCandidates(...)             reused Phase-0 gate (unchanged)
   │     ├─ + provenance.occurrences           coords mapped from matched spans
   │     ├─ + heuristicSkeleton                deterministic draft per candidate
   │     ├─ + priorConfidence / junk filter    precision: rank + drop wasters
   │     └─ + reflections[]                    second stream from same data
   │     ⇒ ExtractionResult { candidates, reflections }
   │
   ├─ distillWorkflow(candidates)              MODIFIED: LLM is now an enricher
   │     try   ACP plan-mode prompt → validateDistilled(+ stitch provenance)
   │     degrade (no-creds/timeout/junk/all-dropped)
   │           → skeletons (origin: "heuristic")
   │     ⇒ { distilled, degraded }
   │
   ├─ controller / stream                      MODIFIED
   │     reflections → recommender gaps[]
   │     payload { candidates, gaps, distilled, reflections, degraded }
   │
   └─ persist
         writeReflections(...) → sidecar       NEW (best-effort)
         accept → writeDistilledDraft(...)      existing
```

New modules: `src/gem/extract.ts` (the seam) and `src/gem/reflectionStore.ts`
(reflection types + sidecar persistence). Both pure / fully unit-testable.

## Section 1 — Provenance & traceability

### Scanner changes (`workflowScan.ts`)

The parse loop already iterates JSONL lines with an index and already knows the
transcript path and per-session timestamps. Capture what is already in hand:

```ts
interface SessionSequence {
  steps: ProcedureStep[];
  missionHint?: { task: string; outcome: string };
  sessionId: string;     // NEW — transcript session id (fallback: `${basename}#${idx}`)
  transcript: string;    // NEW — basename only (not absolute path)
  atMs: number;          // NEW — session timestamp (reuse session firstMs)
}

interface ProcedureStep extends ScrubbedStep {
  tool: string;
  msgIndex: number;      // NEW — JSONL line index this step came from
}

interface ProcedureGroup {
  key: string;
  verbs: string[];
  sessions: number;
  sampleSessionIdx: number;
  sessionIdxs: number[]; // NEW — ALL sessions exercising this procedure
}
```

### Candidate provenance (`extract.ts`)

For each candidate, map the matched procedure span back to source coordinates
across every occurrence:

```ts
interface Provenance {
  occurrences: Array<{
    sessionId: string;
    transcript: string;       // basename
    messageIndices: number[]; // the steps in this session that matched the span
    atMs: number;
  }>;
}
interface ProcedureCandidate extends ProcedureGroup {
  sample: SessionSequence;
  provenance: Provenance;   // NEW
  skeleton: DistilledSkill; // NEW (Section 2)
  priorConfidence: "high" | "medium" | "low"; // NEW (Section 3)
}
```

### Threading to the output (`distill.ts`)

```ts
interface DistilledSkill {
  /* ...existing... */
  origin: "llm" | "heuristic";   // NEW (Section 2)
  evidence: {
    sessions: number;
    exampleSequence: string[];
    root: string;
    provenance: Provenance;      // NEW
  };
}
```

`validateDistilled` already computes `sessions`/`exampleSequence` from the
candidates. It additionally **stitches `provenance`** from the candidate whose
verbs match the validated skill's `exampleSequence`. The LLM never receives or
emits provenance — it is reattached deterministically post-validation.

### UI — DEFERRED (React)

A "jump to source" affordance (open the cited transcript at the message index).
The API payload already carries `evidence.provenance`, so this is purely a
rendering task for the React rewrite. **Specced, not built.**

## Section 2 — Heuristic-first resilience

`extract.ts` builds a deterministic **skeleton** per candidate so distillation
degrades to *something* when the LLM is unavailable:

```ts
function heuristicSkeleton(c: ProcedureCandidate, inv: ScanInventory): DistilledSkill
```

- **name**: kebab-slug from `missionHint.task` (fallback: dominant verb, e.g.
  `git-commit-flow`), deduped against installed skills via the existing
  slug-collision logic. Must be unique or it self-drops in validation.
- **description**: from `missionHint` (task + outcome), truncated.
- **triggers**: ≥1 derived from the mission task phrase. **Non-empty is
  mandatory** — `validateDistilled` drops empty-trigger skills, so a skeleton
  with no trigger would self-reject.
- **tools**: the distinct tools in the spine — grounded by construction, so the
  existing fabricated-tool check passes trivially.
- **mutating**: computed via the existing Bash/Edit/Write/NotebookEdit rule.
- **body**: `## Contract` (stub) / `## Phases` (the ordered spine as steps) /
  `## Output Format` (stub) — clearly a skeleton awaiting human fleshing.
- **confidence**: always `"low"`.
- **origin**: `"heuristic"`.
- **status**: `"draft"`.

### `distillWorkflow` contract change

```
candidates ← extractCandidates(signal, inv).candidates
skeletons  ← candidates.map(c => c.skeleton)

try:
    drafts ← validateDistilled(LLM(candidates), inv, candidates)   // origin:"llm"
    return { distilled: drafts, degraded: false }
on degrade (no-creds | timeout | junk JSON | validation drops all):
    return { distilled: skeletons, degraded: true }                // origin:"heuristic"
```

**`degraded: true` no longer implies an empty result** — that is the resilience
win. When the LLM *succeeds*, skeletons for candidates it dropped are discarded
(we trust the LLM's junk-filtering — confirmed decision). Downstream consumers
read `origin` to label heuristic drafts as "needs fleshing out."

## Section 3 — Extraction precision

Conservative, high-precision (mirrors `extract.rs`): the seam only **ranks and
filters**, never fabricates.

- **Mission-cue scoring.** Candidates whose sessions carry a strong mission hint
  (clear task + an outcome cue such as "shipped / fixed / migrated / merged")
  score higher; pure tool-fingerprint candidates with an empty mission *at
  exactly the minimum recurrence* score lower. Cue lists are small, case-folded
  substring matches (the borrowed `extract.rs` technique), applied to the
  **mission text**, not to mine new facts.
- **Junk filter.** Drop empty-mission + minimum-recurrence candidates — the ones
  that waste LLM spend for no plausible skill.
- **`priorConfidence`.** Each surviving candidate gets a deterministic label.
  The prompt builder sends the top-N by prior (the prompt already caps at 25),
  so the LLM sees *fewer, higher-quality* candidates — lower tokens, higher hit
  rate.

This section is a tuning of the existing gate; it changes ranking/inclusion, not
the candidate type beyond `priorConfidence`.

## Section 4 — Reflections stream

`extract.ts` emits a second stream from already-captured scan data:

```ts
interface Reflection {
  kind: "unresolved-task" | "recurring-decision" | "recurring-pattern";
  detail: string;                 // scrubbed, human-readable
  importance: "high" | "medium";
  provenance: Provenance;         // same coordinate shape as candidates
}
```

Deterministic sources (no new mining pass):

- **unresolved-task** — a recurring spine that never reaches a terminal
  commit/ship verb (started a flow N times, never closed it), or a mission hint
  whose outcome indicates incompletion.
- **recurring-decision** — a procedure that recurs across many sessions but is
  *below* skill-worthiness (e.g. `< MIN_STEPS`): a stable habit, not a skill.
- **recurring-pattern** — the OpenHuman analogue, but driven by the existing
  n-gram recurrence rather than a keyword count.

### Four sinks (all in scope)

1. **Recommender gaps.** High-importance reflections (esp. `unresolved-task`)
   map into `recommendWorkflow`'s `gaps: string[]`, wired in the controller
   where recommend + distill already run under `Promise.all`. Reuses an existing
   consumer; no new UI.
2. **Sidecar persistence.** `writeReflections(reflections, base)` →
   `~/.agentgem/reflections/<root-hash>.json` (structured JSON with provenance),
   reusing the `agentgemHome` pattern from `draftStage`. **Best-effort**: log and
   continue on failure; never blocks `analyze`.
3. **API payload.** `reflections: Reflection[]` added to `WorkflowAnalysis`, the
   `/api/workflow/analyze` response, and the SSE `done` event.
4. **UI panel — DEFERRED (React).** A reflections review panel is specced; data
   is available now via (2) and (3).

## Error handling

- **Scanner provenance capture is defensive.** Missing session id → synthesize
  `${basename}#${idx}`; missing message index → `[]`. Never throws; a transcript
  that fails to yield coordinates degrades to coarse evidence, not a crash.
- **Skeletons must pass `validateDistilled`** (non-empty name/triggers/body,
  unique slug, grounded tools) or they self-drop. A test asserts *every* skeleton
  built from a valid candidate survives validation.
- **Reflection persistence is best-effort** (OpenHuman's ingestion posture):
  log + continue, never block the analyze response.
- **Degrade paths are explicitly tested**: no-creds, timeout, junk JSON, and
  "LLM returned items but validation dropped all" → skeletons returned,
  `degraded: true`.

## Module boundaries / file plan

**New**
- `src/gem/distillTypes.ts` — shared types (`DistilledSkill`, `ProcedureCandidate`,
  `Provenance`, `Reflection`). Extracted here to keep `extract.ts` and
  `distill.ts` **acyclic**: the seam carries a `skeleton: DistilledSkill` and
  `distill.ts` imports `extractCandidates`, so both must depend on the types
  without depending on each other. Pure type module, no runtime code.
- `src/gem/extract.ts` — the seam: `extractCandidates`, `heuristicSkeleton`,
  mission-cue scoring, reflection derivation. Pure, no I/O. Imports types from
  `distillTypes.ts`.
- `src/gem/reflectionStore.ts` — `writeReflections` sidecar (type from
  `distillTypes.ts`).

**Modified**
- `src/gem/workflowScan.ts` — provenance capture (`sessionId`, `transcript`,
  `atMs`, `msgIndex`, `sessionIdxs`).
- `src/gem/distill.ts` — `distillWorkflow` consumes `extractCandidates` and falls
  back to skeletons; `validateDistilled` stitches provenance. (`DistilledSkill` /
  `ProcedureCandidate` definitions move to `distillTypes.ts`; the `origin` and
  `evidence.provenance` fields are added there. Re-exported from `distill.ts` for
  back-compat with existing importers.)
- `src/gem/acpRecommender.ts` + `src/gem.controller.ts` — reflections → gaps;
  `reflections[]` in the analyze payload.
- `src/workflowStream.ts` — `reflections` in the SSE `done` event.
- Schemas for the analyze request/response + draft write.

**Deferred (React rewrite)**
- Provenance "jump to source" affordance.
- Reflections review panel.

## Testing

- **`src/gem/__tests__/extract.test.ts`** (new):
  - provenance `occurrences` map to the correct steps/sessions;
  - every skeleton built from a valid candidate survives `validateDistilled`;
  - skeleton slug dedupes against installed skills;
  - `priorConfidence` ranking + junk filter drop the right candidates;
  - reflection extraction (`unresolved-task`, `recurring-decision`) with correct
    provenance.
- **`src/gem/__tests__/distill.test.ts`** (extend): degrade paths return
  *non-empty* skeletons with `origin: "heuristic"`; success path stitches
  provenance onto `evidence`.
- **`src/gem/__tests__/workflowScan.test.ts`** (extend): `sessionId` / `msgIndex`
  / `sessionIdxs` captured correctly; defensive synthesis on missing ids.
- **Controller / stream**: `reflections` present in payload; `gaps` include
  reflection-derived entries.
- **Privacy regression**: assert provenance contains only coordinates — no raw
  message content anywhere in `occurrences`.

## Out of scope

- Replacing or weakening the existing n-gram recurrence mining.
- A new mining pass for reflections (they ride on already-captured scan data).
- Any net-new vanilla-HTML UI (deferred to the React rewrite).
- Changes to the scrubbing/redaction strategy (`scrub.ts` is unchanged).
