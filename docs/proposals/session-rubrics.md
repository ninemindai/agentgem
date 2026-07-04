# Session Rubrics — named, target-bound factor sets that evaluate sessions into reports

_Draft 2026-07-03. Base: `origin/main` @ 696c877._

## Goal

Let a user assemble named **rubrics** — curated sets of evaluation **factors** — and run one or
more of them over their coding sessions to produce **one report per rubric**. Today the detector
layer is a single flat list applied uniformly to every session, feeding one Insights report
(`src/insightsCore.ts`). This generalizes that into **selectable lenses**: "score my sessions for
_hygiene_", "…for _sellability_", "…for _security_" — same scanned sessions, different rubric,
different report.

The primitive already mostly exists. A `DetectorSpec` (`packages/insight/src/detectors.ts`) is a
factor — `{ id, title, severity, advice, detect() }` with coordinates-only `evidence.msgIndices`
— and `loadRuleDetectors()` (`detectorRules.ts`) already loads declarative, no-code-execution
rules from `~/.agentgem/detectors/*.json`, whose own comment names them "the future distributable
unit for detector-pack Gems." **A rubric is the missing selection/binding layer over those
factors, plus the `cost:"llm"` factor kind that `detectors.ts` stubs but nobody built yet.**

Success criteria:
- A **`Rubric` is declarative data** (`~/.agentgem/rubrics/*.json`) with the same
  load → validate → degrade-to-skipped contract as `loadRuleDetectors` (never throws; bad JSON,
  invalid rules, id collisions all log-and-skip). Distributable as a Gem pack later, unchanged.
- A rubric **selects factors** — built-in `DETECTORS`, declarative rules, and natural-language
  **criteria** — plus an optional **weight** per factor, and **binds to a target report** kind.
- `evaluateRubric(signal, rubric)` runs the selected factors over the scanned sessions and
  returns a `RubricReport` (per-factor findings + a rollup, each finding evidence-linked).
- A streaming `GET /api/rubric/stream?rubric=<id>` endpoint and a console panel that renders any
  rubric's report; multiple rubrics can be selected (one report each).
- **Every existing guarantee preserved**: never-throws degradation, evidence is `msgIndices`
  only (never `arg`/paths — the `detectors.ts` contract), cache tokens, deterministic fallback
  when the agent is unavailable, and **no code execution** (declarative rules and LLM criteria
  are both data/prompts).

## What AgentGem already has (origin/main)

The engine exists; the new work is the **rubric grouping**, the **LLM factor kind**, and the
**panel**.

| Need | Asset (origin/main) | Action |
|---|---|---|
| a "factor" | `DetectorSpec` (`packages/insight/src/detectors.ts:32`) — id/title/severity/advice/`detect`→findings | **reuse as-is** (this is the cheap factor kind) |
| declarative user factors | `DetectorRule` + `validateRule` + `compileRule` + `loadRuleDetectors` (`detectorRules.ts`) — JSON in `~/.agentgem/detectors/`, no code exec | **reuse**; rubrics reference these by id |
| run + aggregate | `runDetectors` / `summarizeFindings` → `DetectorSummary` (`detectors.ts:156/180`) | reuse; `evaluateRubric` calls them on the selected subset |
| transcript scan + spines | `scanWorkflow(paths, inv, {retainSequences:true})` → `WorkflowSignal` (`workflowScan.ts`) | reuse (Insights already does) |
| LLM-as-judge per session | `judgeSessions` → typed facets w/ `outcome` enum (`judgeSession.ts`) | **pattern to copy** for the LLM factor kind |
| naming precedent for "rubric" | gem-checks `judge: { rubric: string, passThreshold? }` (`src/schemas.ts:111`) — a prose "what good looks like" for LLM pass/fail | align vocabulary; §Naming |
| deterministic-first principle | gem-checks design: machine checks primary, LLM-judge is the opt-in escape hatch (`docs/superpowers/specs/2026-06-16-gem-checks-design.md`) | **mirror**: cheap factors are the backbone, criteria are opt-in |
| cache-aware core | `computeInsights` token + `read*/write*CacheEntry` (`insightsCore.ts`) | copy the shape (`rubricToken`) |
| streaming SSE | `streamScorecard` (`src/scorecardStream.ts`), `streamInsights` (`src/insightsStream.ts`) | copy structure for `streamRubric` |
| panel shell | Observe / Insights panels + SSE client (`session-insights.md` step 5) | copy for a Rubric panel |

## Scope — two axes the phrase "per session / per project / all" conflates

Keep them separate (the same discipline that keeps `root` separate from a detector's definition):

**A. Input scope — _what to scan._** Which transcripts feed `scanWorkflow`. Already half-built:
- `all` → `allClaudeTranscripts(claudeDir)` (the `root === "*"` path `computeInsights` uses today, `insightsCore.ts:53`),
- `project` → `claudeTranscriptsForCwd(claudeDir, root)`,
- `session` → a single transcript path.

This is a **run parameter, not a rubric field** — the same rubric is useful pointed at one session,
one project, or everything; pinning scope onto the rubric would force a duplicate rubric per scope.

**B. Report granularity — _how findings roll up._** Per-session (one score each) vs aggregate (one
rolled-up score). Both are already native: detectors emit findings tagged with `sessionId`/
`transcript`, and `summarizeFindings` rolls them across sessions.

**Factor granularity (the one part intrinsic to the lens).** Some factors are session-local
(`retry-storm`, `thrash-loop`, verb-pattern rules — a pattern _within_ one session); others only
mean something aggregated (e.g. breadth = distinct workflows _across_ sessions). Each factor
declares `granularity` (default `"session"`); a rubric is session-granular iff all its factors are.
The engine rejects invalid combinations — an aggregate-only rubric can't run with `scope: session`.

**Natural scope (a default, not a lock).** Granularity alone doesn't fully place a rubric, because
"aggregate" isn't monotone — some aggregates are **project-reach**, some **corpus-reach**:
- _hygiene_ (retry-storm, thrash-loop) → session-granular, **no fixed home**: valid at any scope,
  rolled up over whatever it's pointed at.
- _breadth / coverage_ (distinct workflows — what the scorecard already computes per project root)
  → aggregate, **project-reach**: meaningless per session, mushy across all projects.
- _sellability / generality_ (maturity × cross-project recurrence) → aggregate, **corpus-reach**:
  generality is only visible when the aggregation spans projects, so per-session/per-project can't
  compute it.

So a rubric carries `naturalScope` — the picker's default and the basis for a **soft warning** on
weak combinations (breadth-at-all, sellability-at-project), kept distinct from the **hard validity**
rule above (`scope: session` requires session-granularity). Scope stays a run parameter; the rubric
only *recommends* a home. The project-reach vs corpus-reach split lives in prose for now — promote it
to a structural `reach` field only if a rubric needs the engine to *enforce* it.

```ts
export type RubricScope =
  | { kind: "session"; sessionId: string; root: string }
  | { kind: "project"; root: string }
  | { kind: "all" };
```

`evaluateRubric(signal, rubric, { scope })` selects paths from the scope, runs the factors, and —
when `scope.kind === "session"` or the rubric is session-granular — fills `RubricReport.perSession[]`
alongside the aggregate `factors`/`rollup`. The route mirrors the `root` param the insights route
already takes: `?scope=session|project|all&sessionId=&root=&dir=`.

## New code

### 1. LLM factor kind — `packages/insight/src/criterionJudge.ts`
Closes the `cost:"llm"` case that `DetectorSpec` already declares ("`llm` reserved for future
agent-judged detectors", `detectors.ts:35`). A **criterion** is a natural-language factor — the
thing a verb-pattern rule can't express ("did they verify the fix against the actual reported
case, not a proxy?"). Same finding shape as detectors, so downstream aggregation is unchanged.

```ts
export interface LlmCriterion {
  id: string;                  // kebab-case, unique across factors (same ID_RE as rules)
  title: string;
  question: string;            // the judged criterion, in plain language
  severity?: DetectorSeverity; // default "info"
  advice: string;              // the canonical suggestion when it fires (the "so what")
  granularity?: "session" | "aggregate"; // default "session"; see §Scope
}

// One agent pass (plan-mode / read-only), batched across sessions like judgeSessions.
// Returns DetectorFinding[] (evidence = the msgIndices the judge cites) so runDetectors'
// consumers need no new type. Degrades to [] + degraded:true when the agent is unavailable.
export async function judgeCriteria(
  signal: WorkflowSignal,
  criteria: LlmCriterion[],
  opts?: { connectFn?: AcpConnectFn; timeoutMs?: number; maxSessions?: number; chunkSize?: number; onDelta?: (c: string) => void },
): Promise<{ findings: DetectorFinding[]; degraded: boolean }>;
```

Reuses `judgeSession.ts` plumbing (`defaultConnectFn`, `AcpConnectFn`, the `maxSessions`/`chunkSize`
batching `judgeSessions` already takes, `validate*` + fallback). Prompt: for each session, for each
criterion, emit `{ criterionId, fired, msgIndices, detail }` where `detail` is built from
verbs/counts only (never args — the evidence-scrubbing contract). Unlike `judgeSessions` (which
judges only `missionHint` sessions), criteria run over **all** retained sessions — a hygiene or
security criterion isn't tied to a stated mission.

**Evidence validation (load-bearing).** Cheap detectors emit `msgIndices` mechanically; an LLM
judge can return invalid or hallucinated indices. `judgeCriteria` must **intersect returned
`msgIndices` with the session's real index set and drop the rest** — a finding whose evidence
doesn't resolve is kept as a detail-only note, never surfaced as auditable. This is what preserves
the "auditable back to the transcript" guarantee for the LLM factor kind.

### 2. Rubric type + loader — `packages/insight/src/rubrics.ts`
Declarative data, mirroring `detectorRules.ts` one-to-one (validate, compile-nothing, never
throw, id-dedupe, sorted file read). Lives in `~/.agentgem/rubrics/*.json`.

```ts
export type RubricTarget = "overview" | "sellability" | "security" | string; // open, like detector id

export interface RubricFactorRef {
  factor: string;         // a built-in DETECTORS id, a loaded rule id, or an inline criterion id
  weight?: number;        // default 1; used only by the rollup
}

export interface Rubric {
  id: string;             // kebab-case, unique
  title: string;
  target: RubricTarget;   // selects how the report is framed/rendered
  naturalScope?: "session" | "project" | "all";  // picker default + soft-warn basis (§Scope); default derived from factor granularity
  factors: RubricFactorRef[];
  criteria?: LlmCriterion[];   // inline LLM factors this rubric defines (referenced by id above)
}

export function validateRubric(raw: unknown): Rubric | null;         // same discipline as validateRule
export function loadRubrics(dir?: string): Rubric[];                  // ~/.agentgem/rubrics, degrade-to-skip
export function builtinRubrics(): Rubric[];                           // ships a default set (below)
```

**Built-in defaults** (so the feature works with zero config — the local-first bootstrap):
- `hygiene` → the three existing detectors (`retry-storm`, `thrash-loop`, `no-verify-finish`).
  This makes today's implicit Insights detector pass an explicit, named rubric.
- `sellability` → maturity/generality criteria (LLM factors) — "is this workflow general enough
  to reuse elsewhere?"
- `security` → criteria for secret handling / unbounded permissions surfaced in a session.

### 3. `evaluateRubric()` — `packages/insight/src/rubricReport.ts`
The orchestrator. Resolves each `RubricFactorRef` to a concrete factor, runs cheap ones through
`runDetectors` and criteria through `judgeCriteria`, then aggregates with a generalized
`summarizeFindings` and computes a weighted rollup.

```ts
export interface RubricReport {
  rubricId: string;
  target: RubricTarget;
  factors: DetectorSummary[];          // per-factor rollup across the scanned set
  rollup: { score: number; max: number; bySeverity: Record<DetectorSeverity, number> };
  sessionsScanned: number;
  degraded: boolean;                   // any criterion fell back
  // populated when scope.kind === "session" or the rubric is session-granular (§Scope):
  perSession?: { sessionId: string; transcript: string; factors: DetectorSummary[];
                 rollup: RubricReport["rollup"] }[];
}

export async function evaluateRubric(
  signal: WorkflowSignal, rubric: Rubric,
  opts: { scope: RubricScope; registry?: DetectorSpec[]; judge?: typeof judgeCriteria;
          onDelta?: (c: string)=>void },
): Promise<RubricReport>;
```

Resolution order for a `factor` id: inline `rubric.criteria` → `DETECTORS` → `loadRuleDetectors`.
Unknown id → skipped + logged (never throws). Rollup: each factor contributes
`weight × severityValue × sessionsFired`, normalized against the rubric's max — kept deliberately
simple (see Open decisions; do not build a scoring DSL up front).

### 4. Cache-aware core + stream — `src/rubricCore.ts` + `src/rubricStream.ts`
Built on the **shared cache-aware-compute skeleton** (eng-review §DRY): `rubricCore` supplies only
its compute step. **Cache key = `rubricToken(scope, transcriptToken(paths), canonicalJSON(rubric))`
— hash the rubric's *content*, not its id** (eng-review A1): keying by the slug alone leaves the
cache stale when a rubric's factors/weights are edited in place. Never write the cache on a
`degraded` run (mirror `insightsCore.ts:90` `if (!payload.degraded)`), so an agent-offline result
can't masquerade as authoritative. Copy `scorecardStream.ts` for the SSE shape (SSE:
`start` → `progress` per factor → `done` with the report → `failed`). Register the routes in
**`src/index.ts`** alongside the other SSE endpoints (`/api/scorecard/stream` `:206`,
`/api/insights/stream` `:209`), behind `originGuard`. When a rubric includes LLM criteria the
handler drives the agent, so it must mirror the **insights** route — wrap in the foreground guard
(`endForeground()` in `finally`), not the cheaper scorecard route:
- `GET /api/rubric/stream?rubric=<id>&scope=session|project|all&sessionId=&root=&dir=` — one
  rubric's streamed report at the given scope (§Scope).
- `GET /api/rubrics` — lists available rubrics (built-ins + loaded) for the picker.

### 5. Two console surfaces — apply (`observe`) and manage (`library`)
Rubrics need two distinct surfaces, answering two different questions. The console already splits
this way: `observe` holds the report views (Insights 📊, Mine 💎, Journey 🌙, Optimize, Benchmark),
`library` holds the asset views (Sources, Workspaces, Publish, GetGems, Received).

**5a. Apply — Rubrics report panel (`packages/console/src/panels/Rubrics/`, `group:"observe"`).**
Copy the Observe/Insights shell + SSE client (per `session-insights.md` step 5). A **rubric picker
paired with a scope selector** — the scope defaults to the selected rubric's `naturalScope` (§Scope)
— drives one streamed report per selection. Render `factors` with their `advice`; make each
finding's `msgIndices` a link into the transcript viewer (`docs/proposals/transcript-viewer-ui.md`).

**5b. Manage — Rubrics catalog (`packages/console/src/panels/RubricLibrary/`, `group:"library"`).**
A rubric is a declarative, installable, distributable pack — the same asset class `library` already
holds. Browse built-ins + installed rubric-packs, author/edit (writes `~/.agentgem/rubrics/*.json`),
and inspect a rubric's factors. Group the catalog by `naturalScope` so it reads as "session lenses /
project lenses / corpus lenses." This is the **manage** surface the earlier drafts omitted — the
lens as an owned asset, distinct from applying it.

### 5c. Design (UI/UX) — states, hierarchy, journey

Classifier: **APP UI** (data-dense console, not a landing page). All of the below reuses the
warm-paper token system (`--paper #f4efe3`, `--ink #211c15`, terracotta `--accent #9a3324`,
`--card #fbf8f1`, `--line #ddd2bb`, radius `--r`) and the Insights panel's `phase / degraded /
error / running` states model — no new visual language, no card grids.

**Information hierarchy — advice-first, not score-first.** The report is diagnostic; a score with
no next action is the vanity trap, so the score is demoted to a secondary chip.

```
Rubrics report panel (observe)               Rubrics catalog (library)
┌───────────────────────────────────────┐   ┌──────────────────────────────────┐
│ Hygiene · project · 42 sessions        │   │  Rubrics            [+ New rubric]│
│ 3 checks · 2 need action   [score 68]  │   │  ── Session lenses ──────────────│
│ [rubric ▾] [scope: project ▾]          │   │  Hygiene    3 factors · cheap  ▶ │
├───────────────────────────────────────┤   │  ── Project lenses ──────────────│
│ ⚠ no-verify-finish · 12 sessions       │   │  Breadth    4 factors · cheap  ▶ │
│   → End code-changing sessions with a  │   │  ── Corpus lenses ───────────────│
│     test/build run.        [evidence]  │   │  Sellability 3 factors · LLM   ▶ │
│ ⚠ retry-storm · 4 sessions             │   └──────────────────────────────────┘
│   → Read output before re-running.     │    Row = name · factor count · cost
│ ✓ thrash-loop · no findings            │    badge · Run (▶ deep-links to 5a
│ ▸ Per-session breakdown (42)           │    with this rubric + naturalScope)
└───────────────────────────────────────┘
```

Read order: **verdict line → findings led by their `advice` → score chip → per-session (collapsed)**.
"Constraint worship": if only three things fit, they are the verdict, the top actionable findings,
and what to do next. Severity is a text+icon+color chip (`⚠` warn = `--accent`, `ℹ` info =
`--muted`), never color-only.

**Interaction states (the gap the earlier drafts left entirely).**

| Surface | Loading | Empty | Error | Success | Partial |
|---|---|---|---|---|---|
| Report (5a) | live per-factor progress (reuse Insights `phase`): "Evaluating retry-storm… 3/5 factors" | **no sessions in scope** → not blank: "No sessions here yet — pick a project or run an agent," with a scope switcher | scan/route failure → one inline `--accent` line, panel stays (never a white screen), a Retry action | findings **or** the **clean success state**: "Clean — all N checks passed across M sessions" (a win, lists the checks that passed, not an empty box) | `degraded` → banner "LLM criteria skipped — agent offline; showing cheap-factor results only," cheap findings still shown |
| Catalog (5b) | skeleton rows | built-ins always present, so never truly empty; "No custom rubrics yet — [+ New]" under the built-in groups | bad rubric JSON on disk → that row shows "invalid, skipped" with the reason (mirrors `loadRuleDetectors` degrade), others render | catalog lists lenses grouped by `naturalScope` | one pack failed to load → skip it, surface a quiet count |

The **zero-findings success state is load-bearing**: a hygiene rubric that finds nothing is the
best outcome and must read as thorough (show the checks that ran and passed), not as an empty
panel.

**Journey — close the manage→apply gap.** Catalog (library) and report (observe) live in
different nav groups. The **Run ▶** action on a catalog row deep-links to 5a with that rubric and
its `naturalScope` preselected, so authoring or browsing a lens flows straight into running it —
no hunting through the picker in another nav group. Authoring ends in "Run it now," not "saved to
a file somewhere."

**Authoring UX (decided).** 5b's edit is a **validated JSON editor with a live resolved-factors
preview** — reuse `validateRubric`; show which factor ids resolve (inline criteria → `DETECTORS` →
loaded rules) and which don't. This matches how `~/.agentgem/detectors/*.json` rules are already
hand-authored; a structured factor-picker/weight builder is a **later enhancement**, not MVP.

**Responsive & a11y.** Desktop-first (localhost console; min-width ~900px, graceful narrow, not a
mobile target — stated, not faked). Severity conveyed by icon+label+color (colorblind-safe, never
color-only); picker, scope selector, catalog rows, and evidence links are keyboard-navigable; the
`naturalScope` soft-warning is `aria-describedby`-associated to the scope selector (announced, not
just tinted); verify terracotta `#9a3324` on `#f4efe3` meets 4.5:1 for any body-size use.

## The twist — the lens becomes selectable, ownable data (don't just add detectors)

Today the detector list is fixed and global; Insights renders one hardwired view. Rubrics make
**which factors apply, weighted how, toward which report** a first-class, user-editable, portable
artifact — the same `judge.rubric` idea gem-checks already uses for a single gem, lifted from one
prose string to a **named, composable, target-bound set applied at session scope**. And because a
rubric is JSON with no executable code, it inherits the detector-rule property the code already
calls out: **it is a distributable pack** (Ring 0 local/private today; the same file travels
later). Keep the discipline that makes this safe and honest:
- **Deterministic-first.** Cheap verb-pattern factors are the backbone; LLM criteria are the
  opt-in escape hatch for what patterns can't express — mirroring the gem-checks design principle,
  not inverting it.
- **Evidence-only.** Findings carry `msgIndices`, never args/paths. A rubric report is auditable
  back to the transcript.
- **Local-first, zero-config.** Built-in rubrics work day one with no network and no files.

## Data flow

```
scope ─▶ path-select ─▶ scanWorkflow ─▶ resolve factors ─▶ run ─────────▶ aggregate ─▶ cache/stream
(session/  (1 path /     {retainSequences}   (inline→DETECTORS  cheap: runDetectors  summarizeFindings   rubricToken =
 project/   claudeForCwd/  → WorkflowSignal    →loadRuleDetectors; (Phase 1)          → RubricReport      hash(scope,
 all)       allClaude…)                        collision-checked)  Phase 2: judgeCriteria  (+perSession[])  transcriptTok,
                                                                                                            canonicalRubric)
```

## Build sequence

**Phase 1 — cheap factors only (eng-review scope decision).** No agent on the critical path.

0. **Refactor first (make-the-change-easy):** extract the shared cache-aware-compute skeleton from
   `insightsCore`/`distillCore`/scorecard (token → cache-read → scan → compute(cb) →
   cache-write-**if-not-degraded**); keep their tests green. `rubricCore` then supplies only its
   compute step (eng-review Q1/DRY).
1. `rubrics.ts`: `Rubric`/`RubricFactorRef`/`naturalScope` types, `validateRubric` (reject bad
   ids **and inline-criterion ids that collide with `DETECTORS`/rules** — eng-review A2),
   `loadRubrics`, `builtinRubrics()` (`hygiene` only). Unit tests, **no agent**: bad id/factors,
   id-collision, missing dir, bad JSON → degrade-to-skip (mirror `detectorRules.test`).
2. `rubricReport.ts`: `evaluateRubric` over **cheap factors** (reuse `runDetectors` +
   `summarizeFindings` **as-is** — no "generalization" needed, eng-review Q2); `RubricScope` path
   selection incl. the `sessionId → transcript path` resolver (eng-review A3); granularity guard
   (aggregate-only + `scope:session` → **reject**); `perSession[]`; **counts + severities, no
   numeric score for MVP** (eng-review Q3). Tests: one per scope, the granularity-reject case, the
   `perSession` case, and the **clean/zero-findings success payload**.
3. `rubricCore.ts` (on the step-0 skeleton) + `rubricToken` **content-hash** cache + a `rubricToken`
   **regression test** (edit rubric body → new token, eng-review A1) + `rubricStream.ts` +
   routes (`/api/rubric/stream`, `/api/rubrics`); an SSE `[→E2E]` test mirroring `scorecardStream`.
4. Apply surface (§5a/§5c): Rubrics report panel + rubric/scope picker (`observe`) — the states
   table (esp. the **clean success state**), advice-first hierarchy, live per-factor progress.
5. Manage surface (§5b/§5c): Rubrics catalog panel (`library`) — browse/inspect + **validated-JSON
   editor** with resolved-factors preview, grouped by `naturalScope`, `Run ▶` deep-link into §5a.
6. `pnpm build` + `vitest run` (CI skips the console — run its tests locally).

**Phase 2 — LLM criterion factor kind (deferred).** `criterionJudge.ts` (`judgeCriteria`) reusing
`judgeSession` plumbing + `maxSessions`/`chunkSize` caps (log truncation, no silent caps); evidence
validation (intersect returned `msgIndices` with the session's real set); **degraded never cached**;
a `[→EVAL]` on the criterion prompt + a hallucinated-`msgIndices`-dropped test; wire criteria into
`evaluateRubric` and the corpus-reach built-ins (`sellability`).

_Perf note (eng-review P1): MVP runs one rubric at a time. When multi-rubric lands, cache the
`WorkflowSignal` per `(scope, transcriptToken)` and run all rubrics over one scan — don't re-scan
per rubric._

## Open decisions

- **Scope: run parameter vs rubric field (recommended: run parameter).** §Scope treats input
  scope + granularity as run parameters and lets the rubric/factors declare only the granularity
  they *support*, so one rubric serves all three scopes. The alternative — a `scope` field pinned
  onto the rubric — is right only if some rubrics must be locked to one scope; it costs a duplicate
  rubric per scope otherwise. Validity matrix to enforce: `scope: session` requires a
  session-granular rubric; `all`/`project` accept either (aggregate rolls up, session-granular
  emits `perSession[]`). A rubric's `naturalScope` is a soft default/warning on top of this, not a
  lock.
- **Does `reach` need to be structural?** §Scope keeps project-reach vs corpus-reach (breadth vs
  sellability) in prose, carried by `naturalScope`. If the engine must actually *block* a
  corpus-reach rubric from running per-project (rather than warn), promote it to a `reach:
  "project" | "corpus"` field on aggregate factors. Defer until a real rubric needs enforcement.
- **Scoring model.** Start with counts × severity × weight, normalized — the same currency as
  `summarizeFindings`. A per-target formula or a 0–1 sub-score per factor is a later refinement;
  **resist a scoring DSL until real rubrics demand it.**
- **Per-session vs batch criterion judging.** Same tradeoff as `session-insights.md`: per-session
  = better provenance + more agent calls; batch = one prompt, cheaper. **Lean batch first.**
- **Are Insights / Mine / Journey just built-in rubrics?** The three `observe` report panels look
  like hand-built rubrics at three scopes — Insights (session narrative), Mine (project goldmine),
  Journey (longitudinal). The convergence: the §5a picker eventually drives those three instead of
  each being bespoke, so the apply surface isn't a permanent *fourth* panel. **Stage it** — dedicated
  panels now, converge later; this PR keeps all three working unchanged and does not refactor them.
- **One dir or two.** `~/.agentgem/detectors/` (factors) vs `~/.agentgem/rubrics/` (groupings).
  Lean **two** — a factor is reusable across rubrics; keep the library and the binding separate.
- **Naming vs gem-checks `judge.rubric`.** That rubric judges a *gem's output*; this one evaluates
  *sessions*. Different scope, same word. Keep both; note the distinction in `docs/concepts.md`
  rather than renaming an already-shipped field.
- **Reconcile with the `task-5-report` plan.** The in-flight `wip/task-5-report` branch is
  currently a planning doc only (`.superpowers/sdd/task-5-report.md`), no engine code — so there's
  no code conflict, but since it targets "report," align this rubric report shape with that plan
  before implementation starts, so the two don't define competing report abstractions.
- **Multi-rubric at once (design-review).** §5a's picker: MVP runs **one rubric at a time** (one
  streamed report); multi-select producing stacked/tabbed reports is deferred until the single-lens
  flow is proven — avoids designing a multi-report layout up front.
- **Scope-warning placement (design-review).** The `naturalScope` soft-warning renders as **inline
  helper text** under the scope selector (non-blocking, `aria-describedby`-linked), not a toast or a
  disabled control — the run stays legal, the warning just explains why the number may be weak.
- **Authoring UX (design-review, decided).** Validated JSON editor + resolved-factors preview for
  MVP; structured factor/weight builder is a later enhancement (§5c).
- **Phasing (eng-review, decided).** Phase 1 = cheap factors only; the LLM criterion kind
  (`judgeCriteria`) is Phase 2 — keeps the risky, non-deterministic, agent-driven surface off the
  MVP critical path.
- **Shared core (eng-review, decided).** Extract the cache-aware-compute skeleton shared by
  `insightsCore`/`distillCore`/scorecard before adding `rubricCore` (4th copy = the rule-of-three
  trigger); refactor-first, keep their tests green.
- **NOT in scope.** Structured rubric builder (JSON editor for MVP); multi-rubric simultaneous
  reports (single-rubric MVP); the `reach` structural field (prose + `naturalScope` for now);
  numeric rollup score (counts/severities for MVP). **What already exists / reused:** `DetectorSpec`,
  `runDetectors`/`summarizeFindings`, `loadRuleDetectors`, `judgeSession` plumbing, the
  `insightsCore` cache pattern, and `scorecardStream` SSE — the proposal adds a binding layer, not a
  new engine.

## Implementation Tasks
Synthesized from the design **and** engineering reviews. Each derives from a specific finding.
P1 blocks ship, P2 lands same branch, P3 is a follow-up.

- [ ] **T1 (P1, human: ~4h / CC: ~20min)** — Rubrics report panel — interaction states incl. the clean-success state + `degraded` banner
  - Surfaced by: Pass 2 (states table) — earlier drafts specified no UI states; zero-findings must read as a win, not empty
  - Files: `packages/console/src/panels/Rubrics/`, `src/rubricStream.ts`
  - Verify: panel renders clean/empty/error/degraded without a white screen; console vitest
- [ ] **T2 (P1, human: ~3h / CC: ~15min)** — Rubrics report panel — advice-first hierarchy (verdict → findings-with-advice → score chip → per-session)
  - Surfaced by: Pass 1 (information architecture) — score was undemoted; diagnostic tool must lead with the next action
  - Files: `packages/console/src/panels/Rubrics/`
- [ ] **T3 (P2, human: ~3h / CC: ~15min)** — Catalog + report — `Run ▶` deep-link with rubric + `naturalScope` preselected
  - Surfaced by: Pass 3 (journey) — manage (library) and apply (observe) live in different nav groups
  - Files: `packages/console/src/panels/RubricLibrary/`, `packages/console/src/panels/Rubrics/`
- [ ] **T4 (P2, human: ~4h / CC: ~20min)** — Rubrics catalog — validated JSON editor + resolved-factors preview
  - Surfaced by: Pass 7 (authoring decision) — MVP authoring path, matches `~/.agentgem/detectors/*.json`
  - Files: `packages/console/src/panels/RubricLibrary/`, `packages/insight/src/rubrics.ts`
- [ ] **T5 (P2, human: ~3h / CC: ~15min)** — Both panels — a11y: severity icon+label (not color-only), keyboard nav, `aria-describedby` scope warning, contrast check
  - Surfaced by: Pass 6 (accessibility)
  - Files: `packages/console/src/panels/Rubrics/`, `packages/console/src/panels/RubricLibrary/`
- [ ] **T6 (P3, human: ~1h / CC: ~5min)** — Rubrics panels — token annotations; reuse Insights `phase/degraded` components
  - Surfaced by: Pass 5 (design-system alignment)
  - Files: `packages/console/src/panels/Rubrics/`
- [ ] **E1 (P1, human: ~half day / CC: ~20min)** — extract shared cache-aware-compute skeleton (refactor-first)
  - Surfaced by: Eng-review Q1/DRY — `rubricCore` would be the 4th near-identical core
  - Files: `src/insightsCore.ts`, `src/distillCore.ts`, `src/gem/scorecard.ts`, new shared helper
  - Verify: existing insights/distill/scorecard vitest stay green
- [ ] **E2 (P1, human: ~2h / CC: ~10min)** — content-hash `rubricToken` + never-cache-degraded, with regression test
  - Surfaced by: Eng-review A1 — keying by rubric id leaves the cache stale on in-place edits
  - Files: `src/rubricCore.ts`, `packages/insight/src/rubrics.ts`
  - Verify: editing a rubric body yields a new token → fresh report
- [ ] **E3 (P2, human: ~2h / CC: ~10min)** — `validateRubric` rejects inline-criterion id collisions with `DETECTORS`/rules
  - Surfaced by: Eng-review A2 — resolution order could silently shadow a built-in
  - Files: `packages/insight/src/rubrics.ts`
- [ ] **E4 (P2, human: ~2h / CC: ~10min)** — `sessionId → transcript path` resolver for `scope: session`
  - Surfaced by: Eng-review A3 — findings key on sessionId but scan takes paths
  - Files: `packages/insight/src/rubrics.ts`, `src/rubricCore.ts`

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | 6 issues, 0 critical gaps; Phase 1/2 split + DRY extract decided |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | clean | score 5/10 → 8/10, 7 decisions |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **VERDICT:** ENG + DESIGN CLEARED — ready to implement (Phase 1 cheap-factors-only). Outside voice (Codex) not run.

NO UNRESOLVED DECISIONS
