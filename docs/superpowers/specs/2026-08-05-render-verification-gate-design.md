# Render-verification gate — design

Date: 2026-08-05 (revised 2026-08-07 after `/plan-eng-review`)
Status: reviewed, ready for an implementation plan
Scope: **Tier 1.5 only.** Tier 2 (real-browser layout checks) is deferred — see "NOT in scope".

## Problem

AgentGem generates self-contained HTML from an agent in three places. Only one of
them is checked, and none of them is checked for whether the document actually
*renders*.

| Surface | Entry point | Checked today |
| --- | --- | --- |
| Miniapp | `saveMiniapp` → `gameGate` (`packages/play/src/miniapps.ts:127`) | static scan + jsdom load-smoke |
| Report | `renderReport` (`packages/insight/src/reportRender.ts:92`) | nothing |
| Dashboard | `dashboardRender` | nothing |

`renderReport` runs `extractHtml(text)`, slices to `MAX_REPORT_HTML`, and returns.
A report whose script throws on load, or whose `#report-data` block is missing,
ships silently — and a missing `#report-data` block means the anti-hallucination
seam described in `REPORT_BUILDER_BRIEF` is gone.

`gameGate`'s own header already names the gap it leaves:

> jsdom cannot see a blank canvas — visual correctness is the human preview's job
> (Tier-2)

Tier-2 is currently "a human opens it and looks." This design does not automate
that; it closes the semantic half and leaves Tier 2 explicitly deferred.

## Prior art

`plannotator/effective-html` (MIT) ends every one of its six skills with a
verify-and-hand-off contract: open the artifact at wide and narrow widths,
exercise every control, check the console, check page-level overflow and focus
visibility, and **state what remains unverified**.

We borrow the contract, not the skills. AgentGem's briefs are already stricter
than effective-html's prose guidance because ours are mechanically enforced; what
we lack is the *verification* half.

## Constraints discovered

1. **jsdom has no layout engine.** `getBoundingClientRect()` returns zeros;
   `scrollWidth`/`clientWidth` are always 0; nothing wraps. Overflow, clipping,
   and wrapping are structurally undetectable there. Confirmed independently by
   axe-core, which disables its `color-contrast` rule under jsdom for this reason.
2. **The smoke worker body is an eval'd source string.** `SMOKE_WORKER_SRC`
   (`gameGate.ts:147`) cannot be a sibling `.js` file because
   `scripts/bundle-bins.mjs` inlines this package into the CLI entrypoints and
   rewrites `import.meta.url`. Checks cannot be passed in as functions, and the
   string is not typechecked — its own comment asks that it stay small.
3. **Both artifact kinds build their visible DOM from script.** Semantic checks
   must run *after* the smoke's ticks, inside the worker's lifecycle.
4. **`@ninemind/miniapp-gate` is published and host-neutral.** It imports nothing
   from `@agentgem/*` and its header warns that a host-specific branch belongs in
   the host instead.
5. **Two `setTimeout(0)` ticks is not a rendering contract.** `gameGate.ts:205-206`
   waits two turns, then closes the window. A document that paints on
   `requestAnimationFrame`, a delayed timer, or async normalization is not done
   yet. Any check asserting "the document rendered" is therefore approximate.
6. **jsdom does not implement the accessible-name algorithm.** A faithful
   `controls[].name` would mean a new dependency or a hand-rolled accname
   implementation inside the untypechecked worker string. Neither is acceptable
   at this scope, so the digest carries an explicitly-approximate `nameHint`.
7. **Adding the gate to `insight` is not dependency-free.** `packages/insight`
   has neither `@ninemind/miniapp-gate` nor `jsdom` today. Wiring the gate pulls
   jsdom into the report and dashboard render graph. (Corrects an earlier draft
   that claimed "zero new runtime dependencies" — true for `miniapp-gate`, false
   for `insight`.)

## Approach

**Tier 1.5 — semantic checks in the existing jsdom worker.** Runs everywhere the
CLI and the Electron desktop run. Hard gate for `fail` findings; `warn` findings
ride along without blocking.

The alternative of baking selectable check ids into the worker string was
rejected: it grows an untypechecked string its own comment asks to keep small,
and it puts report-shaped knowledge inside the host-neutral published package.

## Architecture

The worker produces a structured digest; typed check functions consume it on the
main thread.

```
                    ┌──────────────────────────────────────────┐
                    │  @ninemind/miniapp-gate  (published)     │
                    │                                          │
   html ──────────► │  staticGate ──► scriptCode()             │
                    │       │           (executable bodies)    │
                    │       ▼                                  │
                    │  smoke worker (isolated thread)          │
                    │    parse ─► execute ─► settle ─► DIGEST  │
                    │       │                          │       │
                    └───────┼──────────────────────────┼───────┘
                            │                          │
                  failures: string[]     digest: RenderDigest | "not-executed"
                            │                          │
              ┌─────────────┴──────────┬───────────────┴──────────┐
              ▼                        ▼                          ▼
      @agentgem/play           (shared checks)            @agentgem/insight
      miniapp adapter          in miniapp-gate            report checks
              │                        │                          │
              └────────────► runChecks(digest, checks) ◄──────────┘
                                       │
                                  Finding[]  { id, severity, message, evidence? }
                                       │
                       ┌───────────────┴───────────────┐
                  severity:"fail"                severity:"warn"
                       │                               │
              blocks Save / triggers          rides along in the
              one repair turn                 result, never blocks
```

`play` already depends on `miniapp-gate`. `insight` gains that dependency, and
jsdom transitively (constraint 7).

Shared types live in `miniapp-gate`, not `@agentgem/model`, because
`miniapp-gate` commits to importing nothing from `@agentgem/*`.

### API changes

```ts
export type Severity = "fail" | "warn";

export interface Finding {
  id: string;
  severity: Severity;
  message: string;
  evidence?: string;
}

export type Check = (d: RenderDigest) => Finding[];
export function runChecks(d: RenderDigest, checks: Check[]): Finding[];

export interface GateOptions {
  maxBytes?: number;
  allowNetwork?: boolean;
  /** Compute the digest. OFF by default — see "Cost" below. */
  digest?: boolean;
}

export interface GateResult {
  ok: boolean;
  failures: string[];
  /** Never optional. "not-executed" means nothing was examined — it is NOT a pass. */
  digest: RenderDigest | "not-executed";
}
```

**`digest` is non-optional with an explicit sentinel** (review issue 3). An
optional field made the silent-skip spelling the easy one, and this codebase has
already shipped that bug once: `JudgeCoverage.truncated` was added so partial
examination could not pass silently, then `rubricReport` never consulted it, so
the very run it existed to catch still rendered clean. A consumer must now name
the unexamined case before it can read a field.

`saveMiniapp:127` reads only `ok` and `failures`, so it compiles unchanged.

### The digest

Serialized inside the worker after the settle, posted alongside `{ ok, failures }`.

```ts
export interface RenderDigest {
  title: string | null;
  ids: string[];                                 // document order
  bodyElementCount: number;                      // rendered element nodes in <body>
  controls: {
    tag: string;                                 // button, a[href], [role=button]
    nameHint: string;                            // APPROXIMATE — see below
  }[];
  images: { hasAlt: boolean; src: string }[];
  jsonBlocks: { id: string; parses: boolean; empty: boolean; bytes: number }[];
  attachedExternal: string[];                    // external URLs on nodes IN the DOM
  ariaRefs: { attr: string; target: string; resolves: boolean }[];
  hasCanvas: boolean;
  hasVectorOrImageContent: boolean;              // svg / img / canvas present
}
```

Three fields carry design weight, and two of them are deliberately narrower than
an earlier draft claimed:

- **`attachedExternal`** (was `runtimeExternal`). It lists external URLs on nodes
  that are **in the DOM** after execution. It does **not** catch
  `new Image().src = url`: that element is never attached, so no DOM walk can see
  it. Catching detached loads needs setter/constructor instrumentation, which is
  out of scope here. The earlier draft claimed this field closed the static
  scan's documented `new Image()` gap; that claim was wrong and is withdrawn.
  The gap remains open and is listed under Failure modes.
- **`nameHint`** is `textContent` plus `aria-label` plus a resolved
  `aria-labelledby` — **not** the accessible-name algorithm (constraint 6). It is
  named `nameHint` so no caller mistakes it for accname. The `unnamed-control`
  check that reads it is `warn`, never `fail`, precisely because the input is
  approximate.
- **`empty`** on `jsonBlocks` is computed in the worker where the parse already
  happens. A byte count cannot distinguish `{}` from a populated object of the
  same length, and `report-data-empty` is a `fail`.

`bodyElementCount` replaces the earlier `bodyTextLength`: "no text" wrongly
condemns a valid SVG- or image-only document and wrongly passes a document of
invisible text.

The digest carries no field that no check reads. A heading-order check was
considered and cut: neither brief constrains heading structure, so the check
would assert a rule we never wrote down.

### Cost

Computing the digest is **opt-in** (`digest: true`), default off (review issue 7).
There are three `gameGate` call sites and only one reads the digest:

| Call site | Reads | Digest? |
| --- | --- | --- |
| `miniapps.ts:127` (Save) | `failures`, digest | yes |
| `miniapps.ts:235` (checkpoint gem write) | `.ok` only | no |
| `miniapps.ts:307` (inside `migrateAllMiniapps`) | `.ok` only | no |

`:307` runs once per miniapp, serially awaited, in a registry-wide pass. The
current measured cost is ~300ms warm / ~520ms cold per entry; a DOM walk on top
of that, for a value the call site discards, multiplies across the registry.

## Check sets

Shared, in `miniapp-gate`:

| id | severity | rationale |
| --- | --- | --- |
| `duplicate-id` | fail | breaks `getElementById` and every ARIA reference downstream |
| `attached-external-resource` | fail | self-containment violation on an attached node |
| `blank-render` | **warn** | `bodyElementCount === 0 && !hasVectorOrImageContent` |
| `broken-aria-ref` | warn | |
| `unnamed-control` | warn | reads the approximate `nameHint` |
| `missing-alt` | warn | |

`blank-render` is `warn`, not `fail`, and that is a deliberate reversal from the
first draft. It is the check most exposed to constraint 5: a document that paints
on `requestAnimationFrame` or a delayed timer has not finished when the worker
snapshots, so a `fail` here would block legitimate Saves and burn repair turns on
documents that are fine. It is worth keeping as a signal; it is not yet worth
trusting as a gate. Promoting it to `fail` requires a trustworthy settle
condition — captured as a TODO.

Report-only, in `@agentgem/insight`:

| id | severity | rationale |
| --- | --- | --- |
| `report-data-missing` | fail | no `script#report-data` |
| `report-data-unparseable` | fail | seam present, JSON broken |
| `report-data-empty` | fail | seam parses to nothing |
| `report-truncated` | fail | the slice severed the document (see Call sites) |
| `no-title` | warn | |

**What these checks do and do not prove.** They establish that the seam exists,
parses, and is non-empty. They do **not** prove the rendered numbers were read
from it — a report can carry valid JSON and still hardcode every figure in prose.
Verifying that would require comparing rendered text against the parsed facts,
which is out of scope. The checks must be described this way in code comments so
nobody reads a green result as "the anti-hallucination seam is working."

Miniapp-only, in `@agentgem/play`: an adapter projecting today's static and smoke
results into `Finding[]`. No new miniapp checks.

Contrast checking is **not** in Tier 1.5. jsdom does not resolve the full cascade,
and axe-core disables its own contrast rule there for the same reason.

`staticGate`'s size, `EXTERNAL_ATTR`, and `BARE_IMPORT` checks are unchanged.

### The network scan reads executable code only

`NETWORK_CALL` (`gameGate.ts:69`) currently scans the whole document minus
`type="application/json"` content. That is right for a miniapp, whose text is all
code, and wrong for a report, which is a document *about* code: a report on a
session that misused `fetch` contains that word in body prose and would fail with
"games must be sealed."

Turning the scan off for reports is also wrong — a report is served without a
CSP, so a genuine `fetch()` would fire when opened.

Extract `scriptCode(html)` from `scannableCode`'s existing tag walk, returning
only non-JSON `<script>` bodies, and run `NETWORK_CALL` over that for reports.
The walk already tracks those boundaries; this exposes them.

Known limit: inline event-handler attributes (`onclick="fetch(…)"`) fall outside
`scriptCode`. Listed under Failure modes.

## Call sites

**`saveMiniapp`** — `fail` findings feed `gate.failures`, so the throw text and
the console's "Fix with agent" loop behave as today.

`SaveMiniappResult` consolidates its warning channels into one (review issue 4).
Today it carries `prunedNeeds: GameCapability[]` and `mcpWarnings: string[]`;
adding `findings` alongside would make three shapes for one question. All three
become `findings: Finding[]`, mirrored through `packages/app/src/schemas.ts:912`
and `packages/console/src/api/routes.ts:1129`.

**`renderReport`** — three ordering rules, all load-bearing:

1. **Gate the bytes that ship.** `reportRender.ts:108` slices to
   `MAX_REPORT_HTML` *after* extraction. The gate runs **after the slice**, not
   before — otherwise the verified document is not the delivered one, and a
   truncation that severs the `#report-data` object would still return `ok: true`.
   `truncated: true` is itself a `fail` finding (`report-truncated`).
2. **The repair turn streams nothing.** On any `fail`, send one follow-up prompt
   on the same ACP handle — the agent still holds its document in context — but
   pass **no `onDelta`**. The first document's deltas have already reached the
   client (`gem.controller.ts:662`, `rubric.controller.ts:205`), and there is no
   reset protocol; streaming a second document behind the first would corrupt the
   progress signal. The counter stalls, then the final document arrives.
3. **The budget is shared.** The repair turn reuses the existing `deadline` /
   `left()` budget (`reportRender.ts:99-104`), so total wall clock stays bounded
   by `timeoutMs`. A slow first render leaves no room for repair and the report
   ships with findings recorded — the correct tradeoff, not a bug.

`ReportRenderResult` becomes a discriminated union (review issue 5):

```ts
export type ReportRenderResult =
  | { ok: true; html: string; findings: Finding[]; truncated: boolean }
  | { ok: false; reason: string };
```

A failed render has no document, so it must not be able to carry an empty
`findings` array that reads as "checked, clean." The sole consumer already does
`if (!r.ok) { … return; }` at `gem.controller.ts:672`, so narrowing is free.

**`dashboardRender`** — findings recorded, never blocking. A live incremental
evolve should not drop a frame over a warning.

**Findings must survive the cache.** `dashboardCache` stores `{ sessionId, kind,
token, html, ts }`. Findings recorded only in the render result vanish on every
cache hit and every stale hit (`gem.controller.ts:620`). The cache entry gains a
`findings` field written alongside `html`.

**The cache must not serve pre-gate documents.** `dashboardToken`
(`dashboardCache.ts:22-26`) is `${TOKEN_VERSION}:${mtimeMs}` — transcript mtime
and nothing about the renderer. Ship the gate and every already-cached report,
including the broken ones this exists to catch, keeps being served unchanged.
A finished session's transcript never changes again, so those never age out.

Add a **renderer-version component** to the token rather than bumping
`TOKEN_VERSION` by hand (review issue 1). This is the second occurrence of the
class — `rubricToken` has the identical hole, recorded as a prior learning — so
the fix targets the cause: the token must hash what *produces* the output, and
future renderer changes then self-invalidate.

Note: three independent `TOKEN_VERSION` constants exist —
`analysisCache.ts:23` (`"v4"`), `insightsCache.ts:23` (`"iv3"`), and
`dashboardCache.ts:19` (`"dv1"`). Only `dv1` is in scope. The one test asserting
the format is `src/gem/__tests__/sessionDashboard.test.ts:46`.

## Testing

`renderReport` has **two** tests today (`taskAgent.wiring.test.ts:33,41`), both
about model selection. `gameGate` has five dedicated files and eight
worker-lifecycle tests. The repair loop is the most stateful code in this change
and lands on the thin side of that asymmetry, so it gets a full harness
(review issue 6).

- **`renderReport` — all six paths**, using a scripted stub `connectFn` extending
  the `capturing()` pattern at `taskAgent.wiring.test.ts:36`:
  extractHtml-null → failure union; gate clean → success; gate fail → repair →
  clean; gate fail → repair → still failing (residual findings); `repair: false`;
  budget exhausted → repair skipped, report ships. The budget path needs an
  injectable clock, a seam `reportRender` does not have yet.
- **Gate-after-slice** — a document that passes whole but whose slice severs the
  `#report-data` object must produce `report-truncated`.
- **Repair streams nothing** — assert the repair turn receives no `onDelta`.
- **Digest producer** — worker tests over fixture HTML extending
  `gameGate.worker.test.ts`. The existing eight tests must additionally assert
  `digest === "not-executed"` on their paths (spin, OOM, async escape,
  can't-start), and a new test covers `digest: false` — "not requested" and
  "not executed" must stay distinguishable.
- **Checks** — pure functions over fixture digests. Microseconds, no worker.
- **`scriptCode`** — no scripts / json-only / executable / malformed open tag /
  unterminated `</script>`; and a report whose *prose* contains `fetch` passes.
- **Cache** — a renderer-version change invalidates a cached report; findings
  survive a cache hit. `sessionDashboard.test.ts:46` needs its literal updated.
- **Unified findings** — survive both schema mirrors to the console.

Tests live in three places in this repo (root `src/__tests__/`, feature subdirs
like `src/play/__tests__/`, and `packages/<pkg>/src/__tests__/`). Check all three
before concluding a module is uncovered.

## Failure modes

| Codepath | Realistic production failure | Test? | Handled? | User sees |
| --- | --- | --- | --- | --- |
| Repair turn | Second turn also fails the gate | yes | yes | report ships, findings recorded |
| Repair turn | First render eats the whole budget | yes | yes | report ships unrepaired |
| Gate after slice | Slice severs `#report-data` | yes | yes | `report-truncated` fail → repair |
| Digest walk | Document paints after the settle | no | partial | `blank-render` **warn** only — why it is not a gate |
| `attachedExternal` | `new Image().src = url` — detached, never in the DOM | no | **no** | **silent** — see below |
| `scriptCode` | `onclick="fetch(…)"` outside a script body | no | **no** | silent |
| Cache | Findings lost on a cache hit | yes | yes | findings persisted in the entry |
| Worker | Digest walk throws on hostile DOM | yes | yes | worker isolation → `not-executed` |

**Critical gap (1):** a detached `new Image().src = url` load is caught by
neither the static scan (its own comment concedes this) nor the digest (the node
is never in the DOM), and fails silently. The runtime CSP still blocks it for
miniapps — `default-src 'none'` is the real boundary — but a **report** is served
without a CSP, so for reports this is undetected and unmitigated. Closing it
needs setter instrumentation in the worker. Captured as a TODO.

## Implementation Tasks

Synthesized from this review's findings. Each derives from a specific finding.

- [ ] **T1 (P1, human: ~1h / CC: ~10min)** — miniapp-gate — Extract `scriptCode()` and scan executable bodies only
  - Surfaced by: Architecture issue 2 — `NETWORK_CALL` false-positives on report prose
  - Files: `packages/miniapp-gate/src/gameGate.ts`
  - Verify: a report whose prose contains `fetch` passes; a script calling `fetch()` fails
- [ ] **T2 (P1, human: ~2h / CC: ~20min)** — miniapp-gate — Add the digest producer behind `digest?: boolean`
  - Surfaced by: Architecture (digest design) + Performance issue 7
  - Files: `packages/miniapp-gate/src/gameGate.ts`, `src/index.ts`
  - Verify: `gameGate.worker.test.ts` extended; `:235`/`:307` show no added latency
- [ ] **T3 (P1, human: ~30min / CC: ~5min)** — miniapp-gate — Type `digest` as `RenderDigest | "not-executed"`
  - Surfaced by: Architecture issue 3 — optional field makes fail-open the easy path
  - Files: `packages/miniapp-gate/src/gameGate.ts`
  - Verify: all eight existing worker tests assert the sentinel on their paths
- [ ] **T4 (P1, human: ~2h / CC: ~15min)** — miniapp-gate — `Finding`/`Check`/`runChecks` + six shared checks
  - Surfaced by: Architecture (check sets); `blank-render` demoted per Codex #7/#9
  - Files: `packages/miniapp-gate/src/checks.ts`
  - Verify: pure-function tests over fixture digests
- [ ] **T5 (P1, human: ~1h / CC: ~10min)** — insight — Add `@ninemind/miniapp-gate`; report check set
  - Surfaced by: Codex #4 — insight has neither the gate nor jsdom today
  - Files: `packages/insight/package.json`, `packages/insight/src/reportChecks.ts`
  - Verify: build graph resolves; jsdom cost on the report path measured
- [ ] **T6 (P1, human: ~3h / CC: ~25min)** — insight — Gate `renderReport` after the slice; one repair turn, no `onDelta`
  - Surfaced by: Codex #2 (gate shipped bytes) and #3 (repair streaming)
  - Files: `packages/insight/src/reportRender.ts`
  - Verify: severed-slice fixture yields `report-truncated`; repair turn receives no delta callback
- [ ] **T7 (P1, human: ~1h / CC: ~10min)** — insight — `ReportRenderResult` discriminated union
  - Surfaced by: Code quality issue 5 — `findings` undefined on failure paths
  - Files: `packages/insight/src/reportRender.ts`, `packages/app/src/gem.controller.ts`
  - Verify: `tsc -b`; failure path cannot carry findings
- [ ] **T8 (P1, human: ~1.5h / CC: ~15min)** — insight — Renderer version in `dashboardToken`; persist findings in the cache entry
  - Surfaced by: Architecture issue 1 and Codex #5
  - Files: `packages/insight/src/dashboardCache.ts`
  - Verify: cached pre-gate report regenerates; findings survive a cache hit; update `sessionDashboard.test.ts:46`
- [ ] **T9 (P2, human: ~3h / CC: ~25min)** — play/app/console — Consolidate warning channels into `findings[]`
  - Surfaced by: Code quality issue 4 — three shapes for one question
  - Files: `packages/play/src/miniapps.ts`, `packages/app/src/schemas.ts`, `packages/console/src/api/routes.ts`
  - Verify: Studio tests updated; warnings render without blocking Save
- [ ] **T10 (P1, human: ~4h / CC: ~30min)** — insight — Full `renderReport` test harness, all six paths
  - Surfaced by: Test review issue 6 — two tests today, both model selection
  - Files: `packages/insight/src/__tests__/reportRender.test.ts`
  - Verify: six paths green; injectable clock for the budget path
- [ ] **T11 (P2, human: ~45min / CC: ~8min)** — insight — Comment the honest scope of the `report-data-*` checks
  - Surfaced by: Codex #8 — presence does not prove the numbers came from it
  - Files: `packages/insight/src/reportChecks.ts`
  - Verify: comment states what a green result does and does not mean
- [ ] **T12 (P2, human: ~30min / CC: ~5min)** — miniapp-gate — ASCII diagram of the four settle paths
  - Surfaced by: Required outputs (diagrams) — `gameGate`'s message/error/exit/timeout resolution is prose-only
  - Files: `packages/miniapp-gate/src/gameGate.ts`
  - Verify: diagram matches the four `settle` call sites

## Worktree parallelization strategy

| Step | Modules touched | Depends on |
| --- | --- | --- |
| T1, T2, T3, T4 | `packages/miniapp-gate/` | — |
| T5, T6, T7, T8, T10, T11 | `packages/insight/` | T2, T3, T4 |
| T9 | `packages/play/`, `packages/app/`, `packages/console/` | T4 |
| T12 | `packages/miniapp-gate/` | T2 |

```
Lane A: T1 → T2 → T3 → T4 → T12   (sequential, all in miniapp-gate)
Lane B: T5 → T6 → T7 → T8 → T10 → T11   (sequential, all in insight; waits on A)
Lane C: T9   (play/app/console; waits on T4 only)
```

Execution: Lane A first — it owns the types everything else imports. Then launch
**B and C in parallel worktrees**; they share no module directory. Merge both.

Conflict flags: none. B and C touch disjoint packages. Lane A and Lane C both
depend on T4's exported types, so T4 must land before C starts.

## NOT in scope

- **Tier 2 — real-browser layout and contrast checks.** Deferred to its own pass.
  It shares no code with Tier 1.5 and lands at different call sites, and it needs
  a browser dependency plus a CI job that do not exist yet. Bundling both meant a
  problem in the browser harness would block the cheap gate that closes the live
  hole. Design intent preserved: a `renderCheck(html, viewports)` test helper over
  fixtures at 360/390/1440 across four theme states, skipped when the browser is
  absent, never in the published tarball.
- **Deterministic template output** — `renderRpgTheme`, `scaffolds.ts`,
  `ember.ts`. Same input yields the same output, so a runtime gate is wasted work;
  these want Tier-2 browser tests instead.
- **Detached-resource instrumentation** — catching `new Image().src = url`
  requires patching setters and constructors in the worker. Real gap, separate
  scope; see Failure modes.
- **Verifying that rendered numbers derive from `#report-data`** — would require
  comparing rendered text against parsed facts.
- **axe-core adoption.** Four shared checks map onto axe rules and axe runs in
  jsdom, but it is a heavy dependency on a published package whose worker is
  inlined into the CLI entrypoints, and it adds runtime to every Save. Revisit if
  the hand-rolled set grows.
- **The console-theme contrast debt** in `TODOS.md` — that is `theme.css`, not
  generated HTML. Neither tier touches it.
- **Any change to the runtime CSP or the null-origin sandbox.** This design
  touches the admission heuristic only.

## What already exists

| Existing | Reused or rebuilt |
| --- | --- |
| `gameGate` static scan + jsdom smoke, worker-isolated | **Reused.** Digest rides its lifecycle; no second harness |
| `gameGate.{smoke,canvas,static,worker}.test.ts` + `miniappGate.package.test.ts` | **Reused.** Digest tests extend `worker.test.ts` |
| `extractHtml` (`dashboardRender.ts:88`), shared by report + dashboard | **Reused** as-is |
| `capturing()` stub `connectFn` (`taskAgent.wiring.test.ts:36`) | **Reused** as the repair-loop harness |
| `SaveMiniappResult.mcpWarnings` / `prunedNeeds` | **Rebuilt deliberately** — folded into one `findings[]` (issue 4) |
| `dashboardToken` version mechanism | **Reused, then generalized** to hash the renderer (issue 1) |
| `scannableCode`'s script-tag walk | **Reused** — `scriptCode()` exposes its boundaries |
| `REPORT_BUILDER_BRIEF` + drift guard | **Untouched.** Checks enforce rules the brief already states, so no brief edit and no `skills/agentgem-report/SKILL.md` mirror is needed |

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | ISSUES_FOUND | 10 findings, 10 accepted |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAN | 7 issues, 1 critical gap |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**CODEX:** 10 findings, all accepted. Three corrected factual claims in the draft
(`runtimeExternal` catching detached loads; "zero new runtime dependencies";
`#report-data` presence proving the seam is used). Two changed ordering or
persistence (gate the post-slice bytes; findings must survive the cache). Two
demoted `blank-render` from `fail` to `warn`.

**CROSS-MODEL:** One tension, resolved. The eng review called `blank-render` the
highest-value report check; Codex showed the two-tick settle cannot support it as
a gate and that "no body text" misjudges SVG/image-only documents. Resolution:
keep the check, count body element nodes instead of text, exempt vector/image
content, and demote to `warn` until a trustworthy settle exists. Both reviewers
agreed on everything else.

**VERDICT:** ENG CLEARED — ready to implement. Scope reduced to Tier 1.5; 12
tasks across 3 lanes.

NO UNRESOLVED DECISIONS
