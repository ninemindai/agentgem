# agentgem — Rubric verdict capture: record the human call, calibrate the criterion (Design)

**Date:** 2026-08-08
**Status:** Approved design, pre-implementation
**Project:** `agentgem` (`/Users/rfeng/Projects/ninemind/agentgem`)
**Scope:** Let a person record a verdict — `accepted` / `wrong` / `wontfix` — on a factor that fired
against a session, persist it in its own local store, and feed it back as per-criterion calibration on the
rubric report. Findings are never suppressed. Local-first, single user, console-only. No changes to the
judge, the rubric JSON format, or the `clean` contract.

---

## 0. Motivation

The rubric engine ranks well and remembers nothing about what a person decided.

`criterionJudge` produces findings; `evaluateRubric` summarizes them; the console renders them. Every
signal in that chain flows one direction. When a fire is read and judged wrong, that judgment evaporates —
so the same mis-firing criterion produces the same noise on the next run, and nothing in the system can
distinguish a criterion that catches real problems from one that cries wolf.

The gap is named in the sibling spec. `2026-07-30-criterion-applicability-design.md` §1.1 locked
*"Applicability only — not a general verdict model… Revisit a first-class verdict record only when a
consumer exists."* That was the right call then. The consumer now exists, and it is calibration: **a
criterion dismissed as wrong nine times out of ten is not catching bad sessions, it is a bad criterion.**
No other signal in the system can tell those apart, because the only evidence is in a person's head.

The framing came from Addy Osmani's *"Taste, Judgment and AI"* (2026-08-03), which separates ranking
options — transferable, and what the judge already does well — from committing to a call and owning it,
which is not transferable. This spec is the second half, narrowly scoped: not ceremony, just the record
and the feedback it enables.

**Not a correctness fix.** Unlike applicability, nothing here is currently lying. This is new capability
on a sound primitive.

## 1. Design decisions (locked)

1. **Ledger plus calibration, never suppression.** A verdict records and aggregates. A dismissed finding
   still appears in every future report. Suppression would let a person quietly shrink a denominator — the
   precise failure the roster logic in `criterionJudge.ts` exists to prevent — and a verdict store is a
   bad place to put a mute button.
2. **Three values: `accepted` / `wrong` / `wontfix`.** `wrong` means the criterion mis-fired; `wontfix`
   means it fired correctly and the person is not acting. Only `wrong` calibrates the criterion. A pile of
   `wontfix` is a different diagnosis — the criterion is accurate but its `advice` is not compelling — and
   a two-value vocabulary averages the two into a number that answers neither question.
3. **Key is `(sessionId, factorId)`** — the same composite `criterionJudge.ts:169` already uses to collapse
   duplicate fires. It is stable across runs and identical for cheap detectors and LLM criteria, so
   verdicts apply to **any session-granular factor**. Cheap detectors mis-fire too.
4. **The verdict is about the factor, not the rubric.** A factor can appear in several rubrics; the same
   fire on the same session means the same thing in all of them, so a verdict transfers. `rubric_id` is
   recorded for provenance only and is never part of the key.
5. **Append-only, latest-wins on read.** Changing your mind is data. Writes never destroy a prior row.
6. **Its own sqlite store**, `~/.agentgem/rubric-verdicts.db`, separate from both `transcript-index.db` and
   `artifact-outcomes.db`. See §3.
7. **An unreviewed fire is not an accepted fire.** The calibration denominator counts only fires that
   received a verdict. See §4 — this is the decision most likely to be eroded by a later "simplification."
8. **`evaluateRubric` stays pure.** It has no fs access by design; the store read and the decoration happen
   in `rubricCore` (`packages/app`). See §5.

## 2. Data model

```ts
// packages/insight/src/rubricVerdicts.ts — types + rollup math only, no fs.
export type VerdictValue = "accepted" | "wrong" | "wontfix";

export interface RubricVerdict {
  sessionId: string;
  factorId: string;
  verdict: VerdictValue;
  note?: string;        // optional, human-authored, <= NOTE_MAX chars
  atMs: number;
  rubricId: string;     // provenance only — never part of the key (§1.4)
}

/** Per-factor calibration, all-time, derived from the store alone. */
export interface FactorCalibration {
  reviewed: number;     // distinct (session, factor) pairs carrying a verdict
  accepted: number;
  wrong: number;
  wontfix: number;
}
```

`NOTE_MAX = 500`. Notes are stored verbatim: they are human-authored, so the agent-output scrubbing
contract in `criterionJudge.ts` does not apply, and nothing leaves the machine in v1. A future sync would
need a redaction pass — named in §9, not built.

The report row gains one optional field, decorated after summarizing exactly as `applicableSessions` is
(`rubricReport.ts:145` — "Decorate AFTER summarizing: `summariesForSpecs` is shared with cheap detectors
and keeps one job"):

```ts
// on DetectorSummary, alongside applicableSessions / judgedSessions
calibration?: FactorCalibration;   // absent when the factor has no verdicts, or the store is unreadable
```

Per-session rows carry the individual call so the console can render button state:

```ts
// on RubricReport["perSession"][number]
verdicts?: Record</*factorId*/ string, { verdict: VerdictValue; note?: string; atMs: number }>;
```

## 3. Store — `packages/insight/src/rubricVerdictStore.ts`

Its own `node:sqlite` database at `~/.agentgem/rubric-verdicts.db` (via `agentgemHome()`), modelled on
`artifactOutcomesStore.ts` including `SCHEMA_VERSION`, `KNOWN_SCHEMA_VERSIONS`, and `addColumnIfMissing`
for the paired-ALTER discipline.

The separation argument is that file's own, applied one step further. `artifact-outcomes.db` is separate
from `transcript-index.db` because the index "DROPS every derived table on a schema bump" while LLM
judgments "must never be dropped that way. Opposite lifecycles → separate stores." A human verdict is the
least reproducible row in the system: it cost someone attention and cannot be recomputed at any price. It
gets its own file rather than riding along in a store whose schema will move for unrelated reasons.

```sql
create table if not exists rubric_verdicts (
  id         integer primary key autoincrement,
  session_id text    not null,
  factor_id  text    not null,
  verdict    text    not null,     -- 'accepted' | 'wrong' | 'wontfix'
  note       text,
  rubric_id  text    not null,
  at_ms      integer not null
);
create index if not exists idx_verdicts_pair   on rubric_verdicts(session_id, factor_id);
create index if not exists idx_verdicts_factor on rubric_verdicts(factor_id);
```

Surface:

- `recordVerdict(v: RubricVerdict): void` — one INSERT. Throws on failure (§7).
- `verdictsForSessions(sessionIds: string[]): Map<sessionId, Map<factorId, RubricVerdict>>` — latest row
  per pair by `max(at_ms)`, tie-broken by `max(id)` so two writes in the same millisecond still resolve.
- `calibrationForFactors(factorIds: string[]): Map<factorId, FactorCalibration>` — folds the latest verdict
  per pair, then groups by factor. Factors with no rows are **absent from the map**, never present with
  zeroes (§4).

Both readers accept an optional `base` for tests, mirroring `reflectionStore.writeReflections`.

## 4. The honest denominator

The rate is `wrong / reviewed`, where `reviewed` counts only pairs carrying a verdict:

> `committed-without-tests` — dismissed as wrong in **9 of 12 reviewed calls**. 14 fires here, 3 reviewed.

Never `9 of 24`. An untriaged fire is an unanswered question, and folding it into the denominator as an
implicit pass is the same unfalsifiable-silence failure the roster contract was built to close: a criterion
nobody has looked at would otherwise be indistinguishable from one everyone approved.

Two independent numbers, deliberately not blended:

- **All-time calibration** (`reviewed`, `wrong`, `accepted`, `wontfix`) — from the store alone, spanning
  every report ever run. This is the criterion-quality signal.
- **This report's coverage** (`fires here`, `of those reviewed`) — from the current report joined against
  the store. This tells the reader how much of what they are looking at has been triaged.

A factor with zero verdicts renders **no calibration line at all**, mirroring `criterionJudge.ts:298`,
where a criterion with `judged === 0` is deleted from the map rather than reported as a defensible-looking
`0/0`.

## 5. Wiring

**Read path.** `evaluateRubric` keeps its no-fs contract, so decoration happens one level up in
`packages/app/src/rubricCore.ts` — specifically **after `computeCached` returns, not inside its `compute:`
closure**. `computeRubric` writes its payload to the analysis cache (`rubricCore.ts:192-196`), so
decorating inside `compute:` would bake verdicts into a cached report and a new verdict would not appear
until the cache was invalidated. Decorating the returned `RubricResult.payload` instead keeps verdicts
always-fresh and keeps the cache token free of verdict state — the cached artifact stays a pure analysis
result, which is what it is.

Given a `RubricResult`:

1. Collect factor ids from `report.factors` and session ids from `report.perSession`.
2. `calibrationForFactors` → decorate `report.factors[].calibration`.
3. `verdictsForSessions` → decorate `report.perSession[].verdicts`.

`report.perSession` is absent for an aggregate rubric at scope `project`/`all` (`rubricReport.ts:179`).
That is not an error: step 3 is skipped and step 2 still runs, so factor-level calibration renders while
per-fire buttons do not appear. Calibration is all-time and does not depend on this report having
per-session rows.

Both are pure map-merges over data already in hand. No new scan, no agent call, no change to `clean`,
`degraded`, or `judgeCoverage` — a verdict is an annotation on a report, never an input to whether the
report passed.

**Write path.** One route on `RubricController`:

```
@post("/rubric/verdict", { body: RubricVerdictBody, response: RubricVerdictResponse })
```

`RubricVerdictBody` is a **strict** Zod object (`sessionId`, `factorId`, `verdict` enum, optional `note`,
`rubricId`) — unlike the deliberately permissive `/rubrics/validate` and `/rubrics` bodies, which accept
arbitrary drafts so the endpoint can describe what is wrong. There is no draft here; a malformed verdict is
a client bug and a 422 is the correct answer. `atMs` is server-assigned, not client-supplied.

**Console — session scope only in v1.** There are no per-session factor rows to decorate. `perSession` is
rendered at `panels/Rubrics/index.tsx:110-116` as *either* the `HygieneLeaderboard` *or* a one-line count
("12 sessions tripped a factor"); the only factor rows on screen are the aggregate ones at `:107`, and an
aggregate row spans many sessions so it cannot carry a verdict keyed on `(sessionId, factorId)`.

At `scope === "session"` that ambiguity disappears: the report covers exactly one session, so each
aggregate `FactorRow` **is** that session's result. v1 therefore renders verdict controls on the existing
`FactorRow`, gated on session scope, and builds no new list. This also matches the real gesture — a person
reviews one session and signs off on it.

In `packages/console/src/panels/Rubrics/index.tsx`:

- Three buttons on a **fired** `FactorRow`, shown only when `report.scope === "session"`, reflecting the
  current verdict when one exists. Not shown on passing or not-applicable rows: there is no call to make.
- An optional one-line note input, revealed after a verdict is chosen rather than shown up front — the
  gesture has to stay one keystroke or it will not be used, and an unused control produces no calibration.
- The calibration line on every factor row, at all scopes, per §4. Calibration is all-time and does not
  depend on the current scope.

Current verdict state comes from the `perSession` entry whose `sessionId` matches the panel's selected
session. Keeping the data on `perSession` rather than on a scope-conditional top-level field means the
per-session list (§9) can later reuse it unchanged.

Every new `rub-*` className ships with a matching rule in `packages/console/src/shell/theme.css` in the
same change. CLAUDE.md writes that rule for `packages/marketplace` and the `ex-*` prefix, but the console
has the same hand-authored-CSS property and the same failure mode.

## 6. What a verdict does not do

Stated explicitly because each is a plausible next request that would break something above:

- It does not hide, mute, or downrank a finding.
- It does not feed `clean`, `degraded`, `sampled`, or any all-clear.
- It does not reach the judge — no prompt sees prior verdicts. Feeding human calls back into the prompt is
  a defensible future idea and a different spec, with its own bias questions.
- It does not sync anywhere.

## 7. Error handling

Asymmetric on purpose, because the two directions have different costs:

- **Write failure surfaces.** A verdict is user input, and silently dropping it is the one unrecoverable
  bug in this feature — the person believes their call was recorded. `recordVerdict` throws; the route
  answers non-2xx; the console shows the row as unsaved and keeps the buttons live. This deliberately
  departs from `reflectionStore`'s best-effort write, which is right for a derived secondary signal and
  wrong here.
- **Read failure degrades to absent, never to zero.** An unreadable store means calibration is omitted
  from the report — no line rendered. It must never render `0 wrong of 0 reviewed`, which would read as "a
  criterion nobody has ever disputed." Logged at `warn` via `createLogger("insight")`; the report is
  otherwise unaffected and still renders every finding.

## 8. Testing

Unit, in the **root** `src/__tests__/` — where the direct precedents already live
(`artifactOutcomesStore.test.ts`, `rubricReport.test.ts`, `rubrics.test.ts`), not
`packages/insight/src/__tests__/`:

1. **Rollup math** (`rubricVerdicts.test.ts`, no fs) — latest-wins across multiple rows for one pair;
   `wrong` and `wontfix` counted separately; a factor with no verdicts absent from the map rather than
   zeroed.
2. **Store round-trip** (`rubricVerdictStore.test.ts`, `base` in a tmpdir) — insert/read; same-millisecond
   writes resolved by `id`; a verdict recorded under one `rubricId` is returned when the factor is read
   under another (§1.4); reopening an existing file adds no duplicate columns.
3. **Read-failure degradation** — a store path that cannot be opened yields a report with findings intact
   and `calibration` absent on every row. Asserts absence, not zero.

Integration, in `packages/app`:

4. **Decoration** — `rubricCore` merges calibration and per-session verdicts onto a report without altering
   `clean`, `degraded`, or `judgeCoverage`.
5. **Route validation** — an unknown `verdict` value is rejected 422; `atMs` from the client is ignored.

Console, in the existing `pages.test.ts` style:

6. Buttons render per fired per-session row; clicking posts once and reflects the returned state.

Per CLAUDE.md the console is jsdom, which asserts behavior and never appearance — the calibration line and
button styling get a real-browser check via the `verify` skill before the PR lands.

## 9. Out of scope

- **Aggregate-granularity criteria.** They have no `sessionId`, so `(sessionId, factorId)` cannot key them.
  Verdicts on aggregate factors need a report-instance identity, which is a separate design.
- **CLI entry.** A verdict is a review gesture on a rendered report; a headless path needs its own
  interaction design and has no user yet.
- **Sync to the aggregator**, and with it the actor identity, the `contributeAllowed` governance check, and
  note redaction. §1 chose local-first; the record already carries `atMs` and `rubricId`, so a later sync
  adds fields rather than reshaping rows.
- **The per-session verdict list.** Verdict controls at `project`/`all` scope need a new disclosure UI
  listing each affected session and its fired factors. Most fires appear at those scopes, so this is the
  obvious follow-up — deferred until verdicts prove they get used at all. The `perSession[].verdicts`
  shape in §2 is already the right shape for it.
- **Suppression / snooze** (§1.1, §6).
- **Feeding verdicts back into the judge prompt** (§6).
