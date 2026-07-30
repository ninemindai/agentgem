# agentgem — Criterion applicability: give LLM criteria an honest denominator (Design)

**Date:** 2026-07-30
**Status:** Approved design, hardened by `/plan-eng-review` (2026-07-30), pre-implementation
**Project:** `agentgem` (`/Users/rfeng/Projects/ninemind/agentgem`)
**Scope:** Teach the LLM criterion judge to distinguish *"this criterion did not apply to this session"* from *"it applied and did not fire."* Today the two collapse, so a criterion row reports `count: 0, sessions: 0` whether it passed everywhere or was never relevant anywhere. Adds an applicability roster to the judge's wire contract, two optional denominator fields to `DetectorSummary`, and a truncation count to `JudgeCoverage`. Criteria stay problem-shaped; rubric JSON is unchanged; no migration.

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
3. **The judge reports applicability** — in the same JSON response. No new criterion authoring fields, no
   second agent round-trip, no structural precondition language.
4. **Positive evidence, not silence** *(revised by review — see §2)* — the judge returns an explicit
   **per-session roster** of not-applicable criterion ids. An empty array is evidence it considered the
   question. A session **absent** from the roster was not judged and enters no count. Within a rostered
   session, silence still means applicable-and-passed.
5. **Uncertainty is not a pass** *(added by review)* — a criterion the judge cannot assess goes in the
   roster, not in silence. The bucket therefore means **"not assessed"** (did not apply, or could not be
   determined), and `applicableSessions` means *applied **and** was assessable*.
6. **Fired implies applicable** — a criterion listed as not-applicable that also has a fired row is a
   contradiction; the finding wins and the roster entry is discarded.
7. **`clean` gains a blackout guard** *(revised by review — see §6)*. Decision 5 makes the roster a mixed
   bucket, so "zero applicable" is no longer proof of a complete look.
8. **Nothing unverified counts** *(added by review)* — a chunk whose response failed to parse, and a
   session whose step list was truncated, are excluded from the denominator. See §3 and §5.

## 2. Wire contract (`criterionJudge.ts` PROMPT)

The original design had the judge stay silent for not-applicable pairs. The review rejected it: silence is
unfalsifiable — a judge that never emits a not-applicable row is indistinguishable from one that
correctly found none, so a lazy judge yields *"applicable everywhere, passed everywhere"* and no test can
detect it. The roster costs one small object per session (chunks are 8 wide) and makes anti-omission
testable.

```
For EACH session in the chunk and EACH criterion, decide:
  1. applicable — could this criterion meaningfully apply to this session at all?
     If you cannot determine either way, treat it as NOT applicable.
  2. fired      — if applicable, did the described thing occur?

Return BOTH:
  "sessions": one entry per session in the chunk, listing the criterion ids that
              do not apply (empty array when they all apply). Do not omit a session.
  "results":  one row per criterion that FIRED, with the step indices evidencing it.

{"sessions":[{"sessionId":"…","notApplicable":["…"]}],
 "results":[{"sessionId":"…","criterionId":"…","fired":true,"msgIndices":[…]}]}

Within a rostered session, a criterion absent from notApplicable and absent from
results applied and did not occur.
```

Accounting, per criterion:

```
rostered   = sessions present in "sessions" AND whose chunk parsed AND not step-truncated
judgedSessions     = |rostered|
applicableSessions = |rostered| − |{s ∈ rostered : criterionId ∈ s.notApplicable}|
firedSessions      = distinct sessions with a fired row   (deduped — see §4)
```

**`judgedSessions` is not "sessions the judge returned a fired row for."** Most sessions produce no fired
row, and those are precisely the passes the denominator needs. It counts rostered sessions.

**The denominator is run-local.** `maxSessions` defaults to 30, so this reads "of the 30 most recent
eligible sessions" and shifts every run. It is a per-run readout, explicitly **not** a trend metric —
do not persist it or compare it across runs without also pinning the session set.

## 3. Failure paths that must not inflate the denominator

Two paths silently produced free passes in the original design. Both are closed here.

**Parse failure.** `judgeBatch` returns `degraded: false` unconditionally after a successful agent call,
and `validateCriterionResults` returns `[]` for unparseable JSON. Under a silence-means-pass rule a
garbage response became an entire chunk of passes reported as `clean`. The validator now returns an
explicit `ok` flag; `judgeBatch` maps `ok: false` to `degraded: true`, and the chunk enters **neither**
count.

**Step truncation.** The judge sees `steps.slice(0, MAX_STEPS_PER_SESSION)` (80), but coverage counts the
whole session. A criterion that first applies at step 81 would read as applicable-and-passed. Truncated
sessions are excluded from `judgedSessions`. Their fired rows still count as findings — a fire we
actually observed is real evidence and must not be hidden.

Truncation is a per-session coverage fact, not a per-criterion one, so it is reported on `JudgeCoverage`
rather than on every row:

```ts
export interface JudgeCoverage {
  eligible: number; judged: number; sampled: boolean;
  truncated: number;   // NEW — sessions whose step list was clipped at MAX_STEPS_PER_SESSION
}
```

## 4. Types

### `criterionJudge.ts`

`validateCriterionResults` returns `DetectorFinding[]` today. One caller (`judgeBatch`), no existing
tests, so the return type widens safely:

```ts
export function validateCriterionResults(
  text: string, sessions: SessionSequence[], criteria: LlmCriterion[],
): {
  ok: boolean;                                              // false => unparseable; chunk degrades
  findings: DetectorFinding[];                              // deduped on (sessionId, criterionId)
  rostered: Set</*sessionId*/ string>;
  notApplicable: Map</*criterionId*/ string, Set</*sessionId*/ string>>;
};
```

**Dedupe is required, not cosmetic.** `DetectorSummary.count` is total findings while `sessions` is
distinct fired sessions, so a judge that emits two rows for the same pair makes `count` exceed
`applicableSessions` and the row reads as broken. The validator dedupes on `(sessionId, criterionId)`,
keeping the union of valid `msgIndices`.

`judgeCriteria` accumulates across chunks:

```ts
export interface CriterionApplicability { judged: number; applicable: number }

Promise<{
  findings: DetectorFinding[];
  degraded: boolean;
  coverage: JudgeCoverage;
  applicability: Map</*criterionId*/ string, CriterionApplicability>;   // NEW
}>
```

`judgeBatch` is the bridge — it is the only place that knows both the response and the chunk it sent.

### `detectors.ts`

Two optional fields, set only for LLM criterion rows. Cheap detectors run over every session and have no
applicability concept, so theirs stay `undefined`; the report's `sessionsScanned` already covers them.

```ts
export interface DetectorSummary {
  id: string; title: string; advice: string; severity: DetectorSeverity;
  count: number; sessions: number;
  applicableSessions?: number;   // NEW — LLM criteria only
  judgedSessions?: number;       // NEW — LLM criteria only
}
```

### Aggregate criteria

`LlmCriterion.granularity` may be `"aggregate"` (`rubrics.ts:46`). Applicability as defined here is
strictly per-session and has no meaning for an aggregate criterion. Aggregate criteria therefore get
**no denominator** — both fields stay `undefined`, and the renderer falls back to today's wording. This
is a documented gap, not a silent one; defining an aggregate applicability contract is deferred (§10).

### Unchanged

`LlmCriterion`, `Rubric`, and the on-disk rubric JSON in `~/.agentgem/rubrics/`. No migration, no
authoring change, no rubric schema version bump.

## 5. Cache invalidation

`rubricToken` (`packages/app/src/rubricCore.ts:37`) hashes scope + transcripts + rubric JSON. It does not
hash the evaluator, so every cached report predating this change would keep serving without the new
fields until the transcripts or the rubric happened to change.

Add an evaluator version to the token:

```ts
const RUBRIC_EVALUATOR_VERSION = "2";   // bump whenever the report shape or judge contract changes
export function rubricToken(scope, paths, rubric) {
  const rubricHash = createHash("sha1").update(JSON.stringify(rubric)).digest("hex").slice(0, 12);
  return `v${RUBRIC_EVALUATOR_VERSION}|${scopeKey(scope)}|${transcriptToken(paths)}|${rubricHash}`;
}
```

## 6. `clean` — the blackout guard

Originally this design left `clean` untouched, arguing that zero applicable sessions is a *complete look*
and so an honest all-clear. Decision 5 breaks that: the roster now also absorbs "the judge could not
tell," which is not a complete look.

```ts
clean: allFindings.length === 0 && !degraded && !judgeCoverage?.sampled && !criterionBlackout
// criterionBlackout = the rubric HAS criteria AND no criterion had any
//                     assessed-applicable session
```

Deliberately narrow. A rubric with three criteria where two were assessed and one was never applicable is
still `clean`. Only total blackout — nothing assessable at all — flips it, which is the case that would
otherwise render a false all-clear.

## 7. Where it lands

`summariesForSpecs` stays untouched — it is shared with cheap detectors and keeps one job. `evaluateRubric`
decorates criterion rows *after* summarizing. `perSession` rows are **not** decorated; each covers a single
session, where a denominator carries no information.

Two render surfaces consume this, and both must change or the denominator is computed and invisible:

**Console** — `packages/console/src/panels/Rubrics/index.tsx:34` currently reads:

```tsx
{fired ? `${f.count} in ${f.sessions} session${f.sessions === 1 ? "" : "s"}` : "no findings"}
```

`"no findings"` is the lie this whole change exists to fix. It gains an applicability branch. The same
file already renders `judgeCoverage` honestly 26 lines below ("no findings in the {judged} of {eligible}
sessions checked") — this follows that established wording, it does not invent a new one.

`RubricFactorView` (`packages/console/src/panels/Rubrics/rubricStream.ts:9`) is a hand-maintained TS
mirror of `DetectorSummary` and needs both fields. Runtime data is *not* stripped — the `done` event
types `report: z.unknown()` — so this is a types-only update, but without it the panel cannot read the
fields.

**HTML report** — `packages/insight/src/reportBrief.ts` instructs the model that "clean checks collapse
into one quiet 'passed' line," which would erase the distinction. That clause gains an exception: a check
with zero applicable sessions reads as not applicable, never as passed.

## 8. Error handling

Inherits the module's contract — **never throw, degrade and log**:

- Unparseable JSON → `ok: false`; `judgeBatch` sets `degraded: true`; chunk enters neither count.
- A roster entry or fired row citing an unknown `sessionId` / `criterionId` → **dropped**. An invented
  session must not move a denominator.
- A session missing from the roster → not judged; enters neither count.
- `notApplicable` present but not an array of strings → treated as an empty array (the session is still
  rostered, so its criteria read as applicable — the conservative direction).
- Agent failure → unchanged: `{findings: [], degraded: true}`, chunk in neither count.

## 9. Testing

First tests for these modules. Behavior, not construction.

**`validateCriterionResults`**

| Case | Expected |
|---|---|
| roster lists a criterion as not-applicable | no finding; session excluded from that criterion's denominator |
| roster entry with empty `notApplicable` | session counted as applicable for every criterion (a pass) |
| session absent from the roster | neither judged nor applicable |
| unparseable JSON | `ok: false`, empty everything |
| duplicate fired rows for one `(session, criterion)` | one finding, `msgIndices` unioned |
| not-applicable + fired for the same pair | finding wins; applicable |
| roster/fired row citing an unknown session or criterion | dropped from all counts |
| hallucinated `msgIndices` | unchanged — intersected with the session's real index set |
| two criteria with different applicability in one response | per-criterion isolation holds |

**`judgeCriteria`**

| Case | Expected |
|---|---|
| two chunks, one degrades | `degraded: true`; degraded chunk in neither count |
| a session with >80 steps | excluded from `judgedSessions`; `coverage.truncated` incremented; its fired rows still surface |
| no criteria / no judgeable sessions | short-circuits, empty applicability, no agent call |

**`evaluateRubric`** (stub `judge`)

| Case | Expected |
|---|---|
| criterion applicable in 9 of 30, fired in 2 | row carries `count: 2`, `applicableSessions: 9`, `judgedSessions: 30` |
| cheap-detector rows alongside | both new fields `undefined` |
| aggregate criterion | both new fields `undefined` |
| every criterion unassessable, no findings | `clean: false` (blackout guard) |
| one of three criteria never applicable, others assessed, no findings | `clean: true` |

**Console** — `Rubrics/index.tsx` factor row: `applicableSessions: 0` renders as not-applicable, **not**
`"no findings"`; `2` fired of `9` applicable renders the denominator; a row with the fields `undefined`
renders exactly as today (cheap detectors and aggregate criteria must not regress).

**Not covered by tests:** the judge prompt itself. There is no eval harness for `criterionJudge`'s prompt,
so the roster contract can only be verified by unit tests against synthetic responses plus a manual
spot-check on real sessions. Tracked in TODOS.md.

## 10. Files touched

| File | Change |
|---|---|
| `packages/insight/src/criterionJudge.ts` | PROMPT roster contract, `RawResult`, `validateCriterionResults` (+`ok`, dedupe, roster), `judgeBatch` (parse-error → degraded, truncation), `judgeCriteria` accumulation |
| `packages/insight/src/judgeSession.ts` | `JudgeCoverage.truncated` |
| `packages/insight/src/detectors.ts` | two optional fields on `DetectorSummary` |
| `packages/insight/src/rubricReport.ts` | thread applicability, decorate criterion rows, blackout guard, **fix stale header comment** (line 8 claims criteria "are recorded as skipped (Phase 2 wires judgeCriteria)" and that the module is "no LLM"; line 127 calls `judgeCriteria`) |
| `packages/insight/src/rubrics.ts` | **fix stale comment** (line 38 same false Phase-1 claim) |
| `packages/insight/src/reportBrief.ts` | HTML-report prompt: not-applicable ≠ passed |
| `packages/app/src/rubricCore.ts` | `RUBRIC_EVALUATOR_VERSION` in `rubricToken` |
| `packages/console/src/panels/Rubrics/rubricStream.ts` | `RubricFactorView` mirror |
| `packages/console/src/panels/Rubrics/index.tsx` | factor row applicability branch |
| `packages/insight/src/__tests__/criterionJudge.test.ts` | new |
| `packages/insight/src/__tests__/rubricReport.test.ts` | new |
| `packages/console/src/panels/Rubrics/__tests__/factorRow.test.tsx` | new |

**Deferred (not in this change):** an aggregate applicability contract; a first-class `CriterionVerdict[]`
record and its persistence; an eval harness for the judge prompt; a `.agents/behaviors/` importer.

## Implementation Tasks
Synthesized from this review's findings. Each task derives from a specific finding above.

- [ ] **T1 (P1, human: ~1h / CC: ~10min)** — criterionJudge — Return `ok:false` on unparseable JSON and map it to `degraded:true`
  - Surfaced by: outside voice — `judgeBatch:122` returns `degraded:false` unconditionally; `validateCriterionResults` returns `[]` on bad JSON, so a garbage response became a whole chunk of free passes
  - Files: `packages/insight/src/criterionJudge.ts` · Verify: `npm test` (criterionJudge parse-failure case)
- [ ] **T2 (P1, human: ~2h / CC: ~20min)** — criterionJudge — Replace silence-means-pass with a per-session not-applicable roster
  - Surfaced by: outside voice + D2 — silence is unfalsifiable
  - Files: `packages/insight/src/criterionJudge.ts` · Verify: roster + absent-session tests
- [ ] **T3 (P1, human: ~30min / CC: ~5min)** — criterionJudge — Dedupe findings on `(sessionId, criterionId)`, unioning `msgIndices`
  - Surfaced by: outside voice — duplicate rows can make `count` exceed `applicableSessions`
  - Files: `packages/insight/src/criterionJudge.ts` · Verify: duplicate-row test
- [ ] **T4 (P2, human: ~1h / CC: ~10min)** — criterionJudge — Exclude step-truncated sessions from the denominator; add `JudgeCoverage.truncated`
  - Surfaced by: outside voice — judge sees `steps.slice(0,80)` but coverage counts whole sessions
  - Files: `packages/insight/src/criterionJudge.ts`, `packages/insight/src/judgeSession.ts` · Verify: >80-step session test
- [ ] **T5 (P2, human: ~1h / CC: ~10min)** — insight — Add `applicableSessions`/`judgedSessions` to `DetectorSummary`; decorate criterion rows
  - Surfaced by: architecture — no denominator exists today
  - Files: `packages/insight/src/detectors.ts`, `packages/insight/src/rubricReport.ts` · Verify: `evaluateRubric` decoration test
- [ ] **T6 (P2, human: ~30min / CC: ~5min)** — rubricReport — Add the `clean` blackout guard
  - Surfaced by: D1 — zero-applicable is no longer a complete look once the roster absorbs could-not-assess
  - Files: `packages/insight/src/rubricReport.ts` · Verify: blackout test
- [ ] **T7 (P2, human: ~20min / CC: ~5min)** — rubricCore — Add `RUBRIC_EVALUATOR_VERSION` to `rubricToken`
  - Surfaced by: outside voice — pre-change cached reports keep serving the old shape
  - Files: `packages/app/src/rubricCore.ts` · Verify: re-run a cached rubric, confirm new fields appear
- [ ] **T8 (P2, human: ~1h / CC: ~10min)** — console — Mirror the fields in `RubricFactorView`; add the applicability branch to the factor row
  - Surfaced by: architecture + completeness — `index.tsx:34` renders "no findings" for a criterion that never applied
  - Files: `packages/console/src/panels/Rubrics/rubricStream.ts`, `.../index.tsx` · Verify: factor-row render test
- [ ] **T9 (P2, human: ~20min / CC: ~5min)** — reportBrief — HTML prompt: a zero-applicable check is not-applicable, never "passed"
  - Surfaced by: outside voice — `reportBrief.ts` tells the model clean checks collapse into one quiet "passed" line
  - Files: `packages/insight/src/reportBrief.ts` · Verify: manual — download a report for a not-applicable criterion
- [ ] **T10 (P3, human: ~15min / CC: ~5min)** — insight — Fix stale Phase-1 / "no LLM" comments
  - Surfaced by: code quality — `rubricReport.ts:8` and `rubrics.ts:38` contradict line 127
  - Files: `packages/insight/src/rubricReport.ts`, `packages/insight/src/rubrics.ts` · Verify: read
- [ ] **T11 (P1, human: ~2h / CC: ~20min)** — tests — `criterionJudge.test.ts` (roster, dedupe, parse failure, truncation, isolation)
  - Surfaced by: test review — zero tests exist for this module today
  - Files: `packages/insight/src/__tests__/criterionJudge.test.ts` · Verify: `npm test`
- [ ] **T12 (P2, human: ~1h / CC: ~10min)** — tests — `rubricReport.test.ts` (decoration, aggregate, blackout)
  - Surfaced by: test review — 5 `evaluateRubric` cases identified
  - Files: `packages/insight/src/__tests__/rubricReport.test.ts` · Verify: `npm test`
- [ ] **T13 (P2, human: ~45min / CC: ~10min)** — tests — Console factor-row render test incl. the `undefined`-fields no-regression case
  - Surfaced by: test review — "not applicable" vs "no findings" is the user-visible payload of the change
  - Files: `packages/console/src/panels/Rubrics/__tests__/factorRow.test.tsx` · Verify: `npm test`

## NOT in scope

| Deferred | Rationale |
|---|---|
| First-class `CriterionVerdict[]` + persisted passes | No consumer yet. Revisit for behavior-spec import or enterprise adherence-over-time. |
| Aggregate applicability contract | Applicability as defined is per-session; aggregate criteria get `undefined` fields and today's wording. Documented gap, not silent. |
| Eval harness for the judge prompt | Needs a live agent, is non-deterministic, cannot gate CI. Captured in TODOS.md. |
| `.agents/behaviors/` importer | Separate change; the criterion polarity inversion is designed for but not built. |
| Renderer *trend* view of the denominator | The number is run-local (§2). Trending it needs a pinned session set first. |
| Proven-use / Wilson score changes | Different pipeline (`buildArtifactOutcomeRows`). Verified out of scope, not assumed. |

## What already exists (reused, not rebuilt)

| Existing | How this change uses it |
|---|---|
| `JudgeCoverage` + its "a findings-free SAMPLE is not an all-clear" rule | The precedent this whole change extends; gains `truncated` rather than a parallel structure. |
| `summariesForSpecs` count-0 rows | Left untouched; criterion rows are decorated after summarizing. |
| `index.tsx:60` honest coverage wording | The factor-row wording follows it instead of inventing a new phrasing. |
| `origin === "llm"` non-judgment filter | The same "don't let a non-judgment into a number" principle, applied to criteria. |
| `opts.judge` / `opts.connectFn` stub seams | Tests use them; no new plumbing needed. |

## Failure modes

| Codepath | Realistic production failure | Test? | Error handling? | Silent? |
|---|---|---|---|---|
| `validateCriterionResults` | Agent returns prose, not JSON | T11 | `ok:false` → degraded | No (after T1) |
| `judgeBatch` | Agent returns valid JSON, omits a session | T11 | session not rostered → uncounted | No (after T2) |
| `judgeBatch` | Session >80 steps, criterion applies at 81 | T11 | excluded from denominator | No (after T4) |
| `judgeCriteria` | One chunk's agent call times out | T11 | `degraded:true`, chunk uncounted | No |
| `evaluateRubric` | Every criterion unassessable | T12 | blackout guard → `clean:false` | No (after T6) |
| `rubricToken` | Stale cached report predating the change | T7 (manual) | evaluator version busts it | No (after T7) |
| Console factor row | Fields `undefined` (cheap detector / aggregate) | T13 | falls back to today's wording | No |

**Critical gaps (no test AND no error handling AND silent): none.** Every failure mode above was silent
before this change; all are closed by it.

## Worktree parallelization strategy

| Step | Modules touched | Depends on |
|---|---|---|
| T1–T4, T11 | `packages/insight` (judge) | — |
| T5, T6, T10, T12 | `packages/insight` (report) | T1–T4 (needs the applicability shape) |
| T7 | `packages/app` | T5 (needs the new report shape to be worth busting cache for) |
| T8, T13 | `packages/console` | T5 (needs `DetectorSummary` fields) |
| T9 | `packages/insight` (reportBrief) | — (prompt-only, independent) |

- **Lane A:** T1 → T2 → T3 → T4 → T11 (sequential, all in `criterionJudge.ts`)
- **Lane B:** T9 (independent, prompt-only)
- **Lane C:** T5 → T6 → T10 → T12, then T7 and (T8 → T13) in parallel

Launch **A + B** in parallel. Merge. Then **C**. Lanes A and C both touch `packages/insight` —
different files, but land A first to avoid a `rubricReport.ts` conflict.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_found | 7 findings, 7 folded |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | 13 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**CODEX:** 7 findings, all verified against source and folded. The P1 the Claude pass missed: `judgeBatch:122` returns `degraded:false` even when the response failed to parse, so under the original silence-means-pass rule a garbage agent response minted a full chunk of passes and reported `clean`.

**CROSS-MODEL:** One tension, resolved by the user. The Claude pass kept "silence means pass" on token-cost grounds; Codex argued it is unfalsifiable. Codex was right — an omitted not-applicable row is indistinguishable from a considered one. Resolved to the per-session roster (D2). Both reviewers independently reached the same conclusion on the core defect (no denominator) and on including the renderer.

**VERDICT:** ENG CLEARED — ready to implement.

NO UNRESOLVED DECISIONS
