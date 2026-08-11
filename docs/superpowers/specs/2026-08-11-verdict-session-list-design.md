# agentgem — Per-session verdict list: let calibration accumulate where the fires are (Design)

**Date:** 2026-08-11
**Status:** Approved design, pre-implementation
**Project:** `agentgem` (`/Users/rfeng/Projects/ninemind/agentgem`)
**Scope:** Let a person record a verdict at `project` and `all` scope by expanding a fired factor to
reveal the sessions it fired in, each with its own verdict controls. Console-only: no server change, no
schema change, no new route. Completes the feature shipped in #610, whose v1 could only capture verdicts
at session scope.

---

## 0. Motivation

#610 shipped verdict capture that works, and put it where almost nobody will use it.

Verdict controls render only at `scope === "session"`, because that is the only place a factor row maps to
exactly one session and a `(rubricId, sessionId, factorId)` key is unambiguous. That constraint was right.
Its consequence was not measured until the feature was driven in a browser:

| Scope | Fires visible for one factor |
|---|---|
| session | 3 |
| project | **93, across 65 sessions** |

The calibration rate exists to answer "is this criterion any good". It needs samples. As shipped, samples
arrive only from a scope people rarely run, one at a time. The feature cannot produce evidence about
itself, and "the number never moved" would be indistinguishable from "nobody wanted this" — a measurement
trap set by the UI rather than by the idea.

Spec `2026-08-08-rubric-verdict-capture-design.md` §9 named this follow-up and deferred it "until verdicts
prove they get used at all." That test cannot run at 3 samples a session. This is the completion of the
feature, not an enhancement to it.

## 1. Design decisions (locked)

1. **Factor-first, not session-first.** §9 sketched "each affected session and its fired factors". That is
   backwards for this job. The task is *judging one criterion*, so consecutive calls on the same question
   are fast and consistently calibrated; session-first makes you re-read a different criterion every click,
   which is how inconsistent verdicts get recorded. Session-first remains the right shape for the other
   question ("what went wrong in this session"), which `HygieneLeaderboard` already answers.
2. **An inline disclosure, not a new section.** The list expands beneath the factor row it belongs to, so
   the rate you are moving stays on screen directly above the fires you are judging.
3. **The aggregate row never gets buttons at project/all scope.** It spans many sessions and cannot carry a
   `(sessionId, factorId)` verdict. At project/all it shows the rate and the toggle only. At session scope
   the row *is* the session and keeps the buttons it already has (#610, unchanged).
4. **Console-only.** Every field needed already ships on `RubricReportView.perSession[]`.
5. **The list does not re-sort after a verdict.** A row that moves the instant you judge it is hostile in
   precisely the rapid-consecutive-calls situation this exists for.
6. **`HygieneLeaderboard` is untouched.** Different question, different shape, no overlap in practice
   because one is an inline disclosure and the other is a section.

## 2. Data — nothing new is needed

`RubricReportView.perSession[]` (from `packages/console/src/panels/Rubrics/rubricStream.ts`) already
carries every field:

```ts
perSession?: {
  sessionId: string;                       // the verdict key's session half
  transcript: string;                      // the display label
  factors: RubricFactorView[];             // per-session counts — the "3×" on each row
  hygiene?: HygieneVerdictView;
  verdicts?: Record<string, VerdictView>;  // which fires already carry a call
}[];
perSessionTruncated?: boolean;             // the 200-row cap tripped
```

Everything the list renders is derived client-side:

```
firesFor(F)   = perSession.filter(r => (r.factors.find(f => f.id === F)?.count ?? 0) > 0)
countFor(r,F) = r.factors.find(f => f.id === F)!.count
reviewed(r,F) = r.verdicts?.[F] !== undefined
unreviewed(F) = firesFor(F).length − firesFor(F).filter(r => reviewed(r,F)).length
```

No server change, no schema change, no new route, no cache interaction. `withVerdicts` already decorates
`perSession[].verdicts` outside the analysis cache, so an expanded list is as fresh as the report.

## 3. Layout

```
⚠ Same command repeated back-to-back                     93 IN 65 SESSIONS
  → read its full output before re-running it
  called wrong in 1 of 1 reviewed calls · of reviewed fires only
                                                    ▾ 64 unreviewed
  ──────────────────────────────────────────────────────────────────
   agentgem · 3e503dda…        3×   [Accepted] [Wrong] [Won't fix]
   agentgem · a71f0c22…        2×   [Accepted] [Wrong] [Won't fix]
   buzz · 91b4e7f1…            1×   [Accepted] [Wrong] [Won't fix]
   …
   showing 10 of 40 available · 25 more beyond this report's
   200-session cap                                    [ Show more ]
```

Collapsed by default. The toggle carries the unreviewed count, because that is the number that tells you
whether opening it is worth anything. Three cases, not two:

- Unreviewed fires remain: `{unreviewed} unreviewed`.
- None remain, and every fire is present: `all reviewed`.
- None remain, but the report's 200-row cap (§4) clipped this factor below its summary count: `all
  {fires.length} shown reviewed`. Saying plain `all reviewed` here would be the same false coverage claim
  §4 forbids the footer from making — a number implying coverage it does not have — except worse, because
  the footer that discloses the cap is inside the expansion, so it is invisible exactly when the collapsed
  label is what's showing. §4's rule governs this label too, not only the footer.

## 4. Two truncations, never conflated

This is the section most likely to be quietly simplified later, so it is stated plainly.

- **The batch** — "showing 10 of 40" — is a UI choice. Clicking *Show more* undoes it. Nothing is hidden
  that the page does not have.
- **The report cap** — `PER_SESSION_CAP = 200` in `packages/insight/src/rubricReport.ts`, applied as
  `withFindings.slice(0, PER_SESSION_CAP)` across **all factors combined** — is data the report never
  carried. A factor whose summary says "65 sessions" may have far fewer rows present.

So the footer states both, and only mentions the cap when it actually bit:

```
showing {shown} of {available} available                      // cap did not bite
showing {shown} of {available} available · {n} more beyond
  this report's 200-session cap                               // available < summary.sessions
```

`{n}` is `summary.sessions − available`. This is the same rule the rest of the feature runs on: a number
must never imply coverage it does not have. A list that said "showing 10 of 40" while 25 fires were
invisible would be the list-shaped version of the `9 of 24` denominator §4 forbids.

## 5. Sort

Fire count descending — worst-first, matching the panel's own stated principle ("shows what needs action,
worst-first"). Ties break on `sessionId` so the order is total and stable across renders.

**Sorting is computed once per expansion and does not change when a verdict is recorded.** Reviewed rows
stay where they are, marked by their pressed button state. See §1.5.

## 6. Component boundary

New file: `packages/console/src/panels/Rubrics/FactorSessionList.tsx`, a sibling of
`HygieneLeaderboard.tsx` and shaped like it.

```ts
export function FactorSessionList({ factorId, rows, summarySessions, truncated, verdictFor, onRecord, failedIds }: {
  factorId: string;
  rows: PerSessionRow[];          // already filtered to this factor's fires, already sorted
  summarySessions: number;        // the factor summary's `sessions`, for the cap message
  truncated: boolean;             // report.perSessionTruncated
  verdictFor: (sessionId: string) => VerdictValueView | undefined;
  noteFor: (sessionId: string) => string | undefined;
  onRecord: (sessionId: string, factorId: string, verdict: VerdictValueView) => void;
  onNote: (sessionId: string, factorId: string, note: string) => void;
  failedIds: ReadonlySet<string>;   // keyed `${sessionId}\u0000${factorId}` — see §7
}): JSX.Element
```

**Sub-rows carry notes too**, on the same rule as #610: the input is revealed only once a verdict is set,
and posts on blur when the text changed. Omitting notes here would mean you can say *why* a criterion
misfired at session scope but not at project scope — and project scope is where bulk triage happens, so it
is exactly where the reason is most worth capturing. `FactorRow` already has `currentNote` / `onNote`; the
sub-row reuses that shape rather than inventing a second one.

Filtering and sorting happen in `RubricReportCard` and arrive as `rows`, so the component renders and does
not compute — the same split that keeps `HygieneLeaderboard` testable.

`index.tsx` is already past 500 lines; `FactorRow` gains only the toggle and a slot. Nothing else moves.

**`onRecord` grows a `sessionId` parameter.** Today it is `(factorId, verdict)` and closes over the panel's
selected session. That closure is correct at session scope and wrong here, so the session becomes explicit
at the call site. See §8.

## 7. Error handling — already built

#610's fix wave made `failedIds` a `Set<string>`, so per-row failure messages already work. The optimistic
set, the rollback on rejection, and the calibration patch from the POST response are unchanged. A failure
on one sub-row must not disturb its siblings — that is what the Set buys, and it is why nothing new is
needed here.

**`failedIds` must be re-keyed.** It is a `Set<string>` today but holds bare factor ids
(`index.tsx:171`, consumed as `failedIds.has(f.id)` at `:248`). The same factor now has many rows, so a
`factorId`-keyed failure would light up every sibling at once. Re-key to
`` `${sessionId}\u0000${factorId}` `` — the same composite `criterionJudge.ts` and `verdictKey` already
use. Write the separator as the six-character escape, never a literal NUL byte (commit `40089570`).

Session-scope rows key the same way, using the panel's selected session, so there is one keying rule
rather than two.

## 8. Testing

The highest-risk defect in this change is a sub-row POSTing the **panel's selected `sessionId`** instead of
its own row's. The shipped `record` closes over `callable`, and that variable is in scope at the new call
site — this is a one-word mistake that jsdom will not notice unless asked. It gets a dedicated test that
asserts the POSTed `sessionId` equals the row's, with a panel selection deliberately set to a different
session.

Console tests (`pnpm --filter @agentgem/console test`), in
`packages/console/src/panels/Rubrics/__tests__/factorSessionList.test.tsx`:

1. Collapsed by default; no sub-rows in the DOM until the toggle is clicked.
2. The toggle shows the unreviewed count, and `all reviewed` when it is zero.
3. Expanding shows the first batch; *Show more* reveals the next.
4. Footer says "showing X of Y available" when the cap did not bite, and adds the cap clause when
   `available < summary.sessions`.
5. **A sub-row POSTs its own sessionId**, not the panel's selection.
6. The aggregate row has no verdict buttons at project scope; the sub-rows do.
7. Recording a verdict does not re-order the list.
8. A failed write on one sub-row leaves its siblings' state untouched — and specifically, a failure on the
   same factor in a *different* session does not mark this row failed (the re-keying in §7).
9. A sub-row's note input is absent before a verdict, present after, and posts with that row's own
   `sessionId`.

Real-browser pass via the `verify` skill: jsdom has no layout, so indentation, the disclosure affordance,
and the sub-row button sizing at 65 rows can only be judged in Chrome.

## 9. Out of scope

- **The focused review queue** — one fire at a time with keyboard shortcuts. Better suited to the job, and
  a genuinely new surface (modal state, key handling, progress, mid-queue exit). Revisit once the accordion
  shows whether bulk triage actually happens. Noted honestly: if the accordion is tedious enough to
  suppress triage, low volume will look like low demand for the queue. Read the next round's numbers with
  that in mind.
- **Raising `PER_SESSION_CAP`** — the cap protects the payload at `all` scope (1900+ sessions). The list
  discloses it rather than fighting it.
- **Verdicts on aggregate-granularity criteria** — still no session to key on (#610 spec §9).
- **The two parked items from #610** — the dead `VERDICT_VALUES` export and the note-blur ordering. Both
  unrelated to this change.
