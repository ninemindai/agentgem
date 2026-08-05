# Render-verification gate — design

Date: 2026-08-05
Status: approved, ready for an implementation plan

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
seam described in `REPORT_BUILDER_BRIEF` is gone, so every number on the page is
prose the agent typed rather than a value read from the facts.

`gameGate`'s own header already names the gap it leaves:

> jsdom cannot see a blank canvas — visual correctness is the human preview's job
> (Tier-2)

Tier-2 is currently "a human opens it and looks." That manual pass is what this
design partially automates.

## Prior art

`plannotator/effective-html` (MIT) ends every one of its six skills with a
verify-and-hand-off contract: open the artifact at wide and narrow widths,
exercise every control, check the console, check page-level overflow and focus
visibility, test reduced motion, and **state what remains unverified**. Its
`examples/release-readiness/validation.md` records the result as a durable
artifact.

We borrow the contract, not the skills. AgentGem's briefs are already stricter
than effective-html's prose guidance because ours are mechanically enforced; what
we lack is the *verification* half.

## Constraints discovered

1. **jsdom has no layout engine.** `getBoundingClientRect()` returns zeros;
   `scrollWidth`/`clientWidth` are always 0; nothing wraps. Overflow, clipping,
   and wrapping are structurally undetectable there. They need a real browser.
2. **The smoke worker body is an eval'd source string.** `SMOKE_WORKER_SRC`
   (`packages/miniapp-gate/src/gameGate.ts:147`) cannot be a sibling `.js` file
   because `scripts/bundle-bins.mjs` inlines this package into the CLI entrypoints
   and rewrites `import.meta.url`. Checks therefore cannot be passed in as
   functions, and the string is not typechecked — its own comment asks that it
   stay small.
3. **Both artifact kinds build their visible DOM from script.** A report renders
   itself from `#report-data` via inline JS. Semantic checks must run *after* the
   smoke's ticks, inside the worker's lifecycle. A separate pre-execution parse
   would see an empty body.
4. **`@ninemind/miniapp-gate` is published and host-neutral.** It deliberately
   imports nothing from `@agentgem/*`, and its header warns that a second
   host-specific branch is the signal something belongs in the host instead.

## Approach

Two tiers, split by what each engine can actually see.

**Tier 1.5 — semantic checks in the existing jsdom worker.** Hard gate, always
on, zero new runtime dependencies. Runs everywhere the CLI and the Electron
desktop run.

**Tier 2 — layout and contrast checks in a real headless browser.** Test helper
plus a CI job over fixtures. Optional devDependency; never ships to users, never
blocks a Save.

The alternative of putting every check inside the worker string as selectable ids
was rejected: it grows an untypechecked string that its own comment asks to keep
small, and it puts report-shaped knowledge inside the host-neutral package.

## Architecture

The worker produces a structured digest; typed check functions consume it on the
main thread.

```
@ninemind/miniapp-gate       RenderDigest, Finding, Check, runChecks
        ↑                              ↑
@agentgem/play               @agentgem/insight
  miniapp check adapter        report + dashboard checks
```

`play` already depends on `miniapp-gate`. `insight` gains that dependency —
one-way, onto an already-published package.

The shared types live in `miniapp-gate` rather than `@agentgem/model` because
`miniapp-gate` commits to importing nothing from `@agentgem/*`; housing the types
in `model` would either break that commitment or force a dependency inversion.
This is the one place where the digest's producer and its type must stay
together: the digest is a snapshot of what jsdom saw after execution, and only
code inside the worker can take it.

### API changes

`GateResult` gains one optional field. The change is additive, so
`saveMiniapp:127` compiles unchanged.

```ts
export interface GateResult {
  ok: boolean;
  failures: string[];
  digest?: RenderDigest;   // undefined when nothing rendered
}
```

`digest` is `undefined` when `staticGate` short-circuits or the smoke never
starts — in both cases no document was executed, so there is nothing to describe.
Consumers must treat `undefined` as "not checked", never as "passed".

New exports:

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
```

`runChecks` is a thin fold, but it gives one place to sort by severity and dedupe
by id, and it keeps every call site uniform.

### The digest

Serialized inside the worker after the two existing ticks, and posted alongside
`{ ok, failures }`.

```ts
export interface RenderDigest {
  title: string | null;
  ids: string[];                                 // document order
  controls: {
    tag: string;                                 // button, a[href], [role=button]
    name: string;                                // computed accessible name; "" when it has none
  }[];
  images: { hasAlt: boolean; src: string }[];
  jsonBlocks: {
    id: string;
    parses: boolean;
    empty: boolean;                              // parsed to null, {}, [] or ""
    bytes: number;
  }[];
  runtimeExternal: string[];
  ariaRefs: { attr: string; target: string; resolves: boolean }[];
  bodyTextLength: number;
  hasCanvas: boolean;
}
```

Two fields carry design weight:

- **`runtimeExternal`** is a new capability, not merely a new check. `staticGate`'s
  comment concedes that `new Image().src = url` slips past a source-text scan.
  After execution that node exists in the DOM, so the digest catches a class of
  self-containment violation the static scan documents as a known miss. This
  strengthens the *admission heuristic*. The runtime CSP remains the actual
  security boundary and is unchanged.
- **`hasCanvas`** exists to exempt canvas games from `blank-render`. A canvas app
  legitimately has near-zero body text; without the exemption the most common
  miniapp shape would fail on every Save.

`ids` is a plain array rather than a count so a duplicate can be named in the
finding's `evidence`. Duplicate detection is `ids.length !== new Set(ids).size`.

`empty` is computed in the worker, where the parse already happens, rather than
left for a caller to infer from `bytes` — a byte count cannot distinguish `{}`
from a populated object of the same length, and `report-data-empty` is a `fail`.

The digest carries no field that no day-one check reads. A heading-order check
was considered and cut: heading structure is a real accessibility concern, but
neither brief constrains it, so a check would have been asserting a rule we never
wrote down. Add `headings` when a check needs it.

### Check sets

Shared, in `miniapp-gate`, describing any self-contained document:

| id | severity | rationale |
| --- | --- | --- |
| `blank-render` | fail | `bodyTextLength === 0 && !hasCanvas` — the document rendered nothing |
| `duplicate-id` | fail | breaks `getElementById` and every ARIA reference downstream |
| `runtime-external-resource` | fail | self-containment violation the static scan cannot see |
| `broken-aria-ref` | warn | |
| `unnamed-control` | warn | |
| `missing-alt` | warn | |

Report-only, in `@agentgem/insight`:

| id | severity | rationale |
| --- | --- | --- |
| `report-data-missing` | fail | no `script#report-data` — the anti-hallucination seam is gone |
| `report-data-unparseable` | fail | seam present, JSON broken |
| `report-data-empty` | fail | seam parses to nothing, so every number on the page is unverifiable prose |
| `no-title` | warn | |

Miniapp-only, in `@agentgem/play`: an adapter projecting today's static and smoke
results into `Finding[]`. No new miniapp checks — this exists so both kinds speak
one vocabulary.

Contrast checking is deliberately **not** in Tier 1.5. jsdom's `getComputedStyle`
does not resolve the full cascade reliably, so a contrast check there would be
both false-positive-prone and falsely reassuring. It belongs in Tier 2.

`staticGate`'s existing four checks are unchanged.

## Call sites

**`saveMiniapp`** — `fail` findings feed `gate.failures`, so the throw text and
the console's "Fix with agent" loop behave exactly as today. `warn` findings are
returned in `SaveMiniappResult` for display. A warning never blocks a Save.

**`renderReport`** — run the gate after `extractHtml`. On any `fail`, send one
follow-up prompt **on the same ACP handle** rather than re-rendering from
scratch: the agent still holds its own document in context, so "these checks
failed, return the corrected document" is a far smaller ask than a fresh render.
Accept the result and record residual findings. `renderReport` continues never to
throw; its `{ ok: false }` degradation contract is preserved.

The repair turn shares the existing `deadline` / `left()` budget
(`reportRender.ts:99-104`), so total wall clock stays bounded by `timeoutMs` —
there is no doubled worst case. The tradeoff falls out correctly on its own: a
slow first render leaves no room for repair, and the report ships with findings
recorded rather than making the user wait twice as long. A `repair?: boolean`
input defaulting to `true` lets tests pin both paths.

`ReportRenderResult` gains `findings: Finding[]`.

**`dashboardRender`** — findings recorded, never blocking. It is a live
incremental evolve; a rough frame beats a dropped one.

## Tier 2

```ts
export interface Viewport { width: number; height: number; theme: "light" | "dark" | "unset" }

renderCheck(html: string, viewports: Viewport[]): Promise<Finding[]>
```

A test helper driving headless Chrome as an optional devDependency. It covers
only what needs a layout engine:

- page-level horizontal overflow (`documentElement.scrollWidth > clientWidth`)
- clipping and overlap of interactive targets
- computed contrast on every distinct surface — specifically text that inherits
  the body colour inside a tinted or dark region, which is how a themed report
  breaks
- all four theme states: `data-theme="light"`, `data-theme="dark"`, unset, and
  unset under `prefers-color-scheme: dark`

A CI job runs it over fixtures — one golden report, one golden miniapp — at
360 / 390 / 1440. The job is **skipped when the browser is not installed**, so a
local `pnpm test` never breaks and the published tarball is untouched.

## Testing

- **Digest producer** — worker tests over fixture HTML, extending
  `gameGate.worker.test.ts`. Must cover the `digest === undefined` paths
  (static-gate short-circuit, smoke failed to start).
- **Checks** — pure functions over fixture digests. Microseconds, no worker
  spawn. This is the payoff for the digest architecture over baking checks into
  the worker string.
- **Repair loop** — `renderReport` with a stub `connectFn` (`currentTestConnectFn`
  already exists) returning a failing document then a passing one; plus the
  `repair: false` path and the budget-exhausted path.
- **Drift guard** — a `CHECK_IDS` list in the style of `HOUSE_TOKEN_NAMES`, so a
  check registered in one set and forgotten in another fails rather than silently
  never running.

## Out of scope

- Deterministic template output — `renderRpgTheme`, `scaffolds.ts`, `ember.ts`.
  Same input yields the same output, so a runtime gate is wasted work. These want
  Tier-2 browser *tests*, which is a separate and easier piece of work.
- Any change to `staticGate`'s four existing checks.
- Any change to the runtime CSP or the null-origin sandbox. This design touches
  the admission heuristic only; the security boundary is unchanged.
- A user-facing `agentgem verify <file.html>` command. Tier 2 stays a test helper
  so the published CLI acquires no browser dependency.
