# agentgem — Criterion applicability: give LLM criteria an honest denominator (Design)

**Date:** 2026-07-30
**Status:** Approved design, pre-implementation
**Project:** `agentgem` (`/Users/rfeng/Projects/ninemind/agentgem`)
**Scope:** Teach the LLM criterion judge to distinguish *"this criterion did not apply to this session"* from *"it applied and did not fire."* Today the two collapse, so a criterion row reports `count: 0, sessions: 0` whether it passed everywhere or was never relevant anywhere. Adds an `applicable` signal to the judge's wire contract and two optional denominator fields to `DetectorSummary`. Criteria stay problem-shaped; rubric JSON is unchanged; no migration.

---

## 0. Motivation

`packages/insight/src/criterionJudge.ts` prompts for `"fired": true|false` and its validator drops
everything that is not an explicit fire:

```ts
if (!r || r.fired !== true) continue;
```

A grep for `na` / `notApplicable` / `inconclusive` across `packages/insight/src` and `packages/app/src`
returns nothing. So a criterion that never applied and a criterion that applied to all 30 judged sessions
and passed produce the **identical** summary row, and `evaluateRubric` can report `clean: true` off it.
There is no denominator anywhere for *"of the sessions where this could apply."*

This is the third silent overclaim in a module that has already closed the other two:

- `JudgeCoverage` (`{eligible, judged, sampled}`) — "a findings-free SAMPLE is not an all-clear."
- `clean` refuses to be true when `degraded` or `sampled`.
- `buildArtifactOutcomeRows` filters `origin === "llm"` so heuristic placeholders never pollute a score.

Applicability is the same class of honesty, unclosed. Fixing it is a correctness fix to a shipped
primitive, independent of any consumer.

**Out of scope (deliberately).** The proven-use Wilson score in `artifactOutcomesStore.ts` is **not**
affected — it is fed by `buildArtifactOutcomeRows` joining `eventSeries` to `SessionFacet.outcome` from the
*session-outcome* judge, a different pipeline from `criterionJudge`. No change there.

## 1. Design decisions (locked)

1. **Applicability only** — not a general verdict model. No `CriterionVerdict[]`, no persisted passes.
   Findings keep their current meaning; the report gains a denominator. Revisit a first-class verdict
   record only when a consumer exists (behavior-spec import, enterprise adherence-over-time).
2. **Criteria stay problem-shaped** — `fired: true` continues to mean *the noted thing happened*, paired
   with `advice`. No `polarity` field. A future `.agents/behaviors/` importer inverts on the way in (a
   BEHAVIOR.md's **Failure modes** become the criterion question).
3. **The judge reports applicability** — one extra field in the same JSON response. No new criterion
   authoring fields, no second agent round-trip, no structural precondition language.
4. **Silence means pass** — the model returns a row only when the criterion *fired* or *could not apply*.
   An omitted `(session, criterion)` pair is counted as applicable-and-passed.
5. **Unknown reads as applicable** — a missing or unparseable `applicable` inflates the denominator rather
   than shrinking it. Inflating understates the pass rate, which is the conservative direction and matches
   the `judgeCoverage` culture.
6. **Fired implies applicable** — `applicable:false` + `fired:true` is a contradiction; the finding wins
   and the not-applicable claim is discarded.
7. **`clean` is unchanged** — see §5. A deliberate non-change, not an oversight.

## 2. Wire contract (`criterionJudge.ts` PROMPT)

The model speaks up only in the two interesting cases. Enumerating every `(session × criterion)` pair
would balloon the response (chunks are 8 sessions wide) for no information gain, and would risk
prompt-compliance failures on the majority-silent case.

```
For EACH session and EACH criterion, decide:
  1. applicable — could this criterion meaningfully apply to this session at all?
  2. fired      — if applicable, did the described thing occur?

Return a row ONLY when:
  (a) it fired          -> {"sessionId","criterionId","fired":true,"msgIndices":[...]}
  (b) it cannot apply   -> {"sessionId","criterionId","applicable":false}
Omit the pair entirely when the criterion applied and did not occur.
```

Accounting, per criterion:

```
judgedSessions     = sessions SENT to the judge in chunks that did not degrade
applicableSessions = judgedSessions − (sessions explicitly marked applicable:false)
```

Note the definition of `judgedSessions`: it is **not** "sessions the judge returned a row for." Under
silence-means-pass most sessions produce no row at all, and those are precisely the passes we need in the
denominator. The count comes from the chunk that was sent (`chunk.length`), not from the response.

**Rationale for silence-means-pass.** It preserves today's semantics exactly (omission has always meant
"did not fire"), keeps the response size flat, and makes decision 5 fall out for free — anything the model
forgets is scored as applicable, so a forgetful judge makes adherence look *worse*, never better. The
accepted cost: a criterion the judge simply overlooks is indistinguishable from a genuine pass. That is
the same exposure the module already accepts for `fired` today, and `judgeCoverage` remains the signal
that the pass set is not a complete picture.

## 3. Types

### `criterionJudge.ts`

`validateCriterionResults` currently returns `DetectorFinding[]`. It has exactly one caller
(`judgeBatch`) and no existing tests, so the return type widens safely:

```ts
export interface CriterionApplicability {
  judged: number;       // sessions this chunk actually got a response for
  applicable: number;   // judged minus explicit applicable:false
}

export function validateCriterionResults(
  text: string, sessions: SessionSequence[], criteria: LlmCriterion[],
): { findings: DetectorFinding[]; notApplicable: Map</*criterionId*/ string, Set</*sessionId*/ string>> };
```

`judgeCriteria` accumulates across chunks and returns applicability alongside what it returns today:

```ts
Promise<{
  findings: DetectorFinding[];
  degraded: boolean;
  coverage: JudgeCoverage;
  applicability: Map</*criterionId*/ string, CriterionApplicability>;   // NEW
}>
```

The bridge between the two shapes lives in `judgeBatch`, which is the only place that knows both halves:
`validateCriterionResults` reports *which* sessions were inapplicable, and `judgeBatch` supplies the
denominator from the chunk it sent (`chunk.length`) — then `judgeCriteria` sums both across chunks.

A **degraded chunk contributes to neither count.** A session the agent never judged is not applicable and
not inapplicable; it is absent from both, which is exactly what `judgeCoverage` already exists to say.

### `detectors.ts`

Two optional fields, set only for LLM criterion rows. Cheap detectors run over every session and have no
applicability concept, so theirs stay `undefined` — the report's `sessionsScanned` already covers them.

```ts
export interface DetectorSummary {
  id: string; title: string; advice: string; severity: DetectorSeverity;
  count: number; sessions: number;
  applicableSessions?: number;   // NEW — LLM criteria only
  judgedSessions?: number;       // NEW — LLM criteria only
}
```

### Unchanged

`LlmCriterion`, `Rubric`, and the on-disk rubric JSON in `~/.agentgem/rubrics/`. No migration, no
authoring change, no schema version bump.

## 4. Where it lands (`rubricReport.ts`)

`summariesForSpecs` stays untouched — it is shared with cheap detectors and keeps one job. `evaluateRubric`
decorates criterion rows *after* summarizing:

1. `judgeCriteria` returns `applicability` alongside `findings`.
2. After `const factors = summariesForSpecs(allSpecs, allFindings)`, map over `factors` and, for any id
   present in `applicability`, attach `applicableSessions` / `judgedSessions`.
3. `perSession` rows are **not** decorated — each covers a single session, where a denominator carries no
   information.

This is a smaller diff than threading applicability through the shared helper's signature, and it keeps
the cheap-detector path byte-identical.

## 5. `clean` — the deliberate non-change

`clean` remains:

```ts
clean: allFindings.length === 0 && !degraded && !judgeCoverage?.sampled
```

The existing rule refuses `clean` when we **did not look** (degraded, sampled). Zero applicable sessions is
the opposite situation: we looked at everything eligible and the criterion genuinely did not apply. That is
a complete look, so `clean: true` is honest. The nuance belongs on the row — a reader sees
`0 of 30 judged sessions applicable` — not in a report-level boolean. Changing `clean` would also flip
behavior for existing rubrics, which this fix has no mandate to do.

## 6. Error handling

Inherits the module's contract — **never throw, degrade and log**:

- Unparseable JSON → `{findings: [], notApplicable: empty}`; the chunk is degraded by `judgeBatch` as today.
- A not-applicable row citing an unknown `sessionId` or `criterionId` → **dropped**, the same guard
  findings already get. An invented session must not shrink a denominator.
- `applicable` present but not a boolean → treated as applicable (decision 5).
- Agent failure → unchanged: `{findings: [], degraded: true}`, and the chunk's sessions enter neither count.

## 7. Testing

First tests for this module. Behavior, not construction.

**`validateCriterionResults`**

| Case | Expected |
|---|---|
| `applicable:false` row | no finding; session excluded from the denominator |
| pair omitted entirely | no finding; session **counted** as applicable (a pass) |
| `applicable` missing or garbage, `fired:true` | finding; applicable |
| `applicable:false` + `fired:true` | finding; applicable (contradiction rule) |
| not-applicable row, unknown session or criterion | dropped from both counts |
| `msgIndices` containing hallucinated indices | unchanged — intersected with the real index set |

**`judgeCriteria`**

| Case | Expected |
|---|---|
| two chunks, one degrades | `degraded:true`; degraded chunk's sessions in neither count |
| no criteria / no judgeable sessions | short-circuits, empty applicability, no agent call |

**`evaluateRubric` (stub `judge`)**

| Case | Expected |
|---|---|
| criterion applicable in 9 of 30, fired in 2 | row carries `count:2`, `applicableSessions:9`, `judgedSessions:30` |
| cheap-detector rows alongside | `applicableSessions`/`judgedSessions` `undefined` |
| criterion applicable in 0 sessions, no findings | `clean` still `true`; row shows `applicableSessions:0` |

## 8. Files touched

| File | Change |
|---|---|
| `packages/insight/src/criterionJudge.ts` | PROMPT, `RawResult`, `validateCriterionResults` return type, `judgeBatch`, `judgeCriteria` accumulation |
| `packages/insight/src/detectors.ts` | two optional fields on `DetectorSummary` |
| `packages/insight/src/rubricReport.ts` | thread + decorate criterion rows |
| `packages/insight/src/__tests__/criterionJudge.test.ts` | new |
| `packages/insight/src/__tests__/rubricReport.test.ts` | new |

Renderers and `packages/app` consumers need no change — both new fields are optional and additive. Making
a renderer *display* `2 of 9` is a follow-up, not part of this fix.
