# Task 6 report: `ContextTimeline` component + swap into `TranscriptViewer`

## TDD

**RED** — wrote `packages/console/src/panels/Observe/ContextTimeline.test.tsx` verbatim from
the brief (Step 1), ran `pnpm --filter @agentgem/console test -- ContextTimeline`:

```
FAIL  src/panels/Observe/ContextTimeline.test.tsx
Error: Failed to resolve import "./ContextTimeline.js" from
"src/panels/Observe/ContextTimeline.test.tsx". Does the file exist?
```
(85 other suites / 455 tests still passed — confirms the harness itself was healthy.)

**GREEN (first pass, still red)** — implemented `ContextTimeline.tsx` per the brief's Step 3
code verbatim. Re-ran the test: 1 of 2 tests failed —

```
× ContextTimeline > renders the verdict, a fired factor, and a ranked jump
Found multiple elements with the text: /review/i
  <title>skill: review</title>            (inside the SVG marker <circle>)
  <div class="obs-muted">loaded skill review</div>   (the rail's jump-cause line)
```

Root cause: the sample fixture's event name (`review`) and its jump-cause string
(`loaded skill review`) both contain "review", and the brief's marker code renders a
nested `<title>{mk.kind}: {mk.name}</title>` inside the `<circle>` — a real text node
that Testing Library's `findByText` also matches. With both nodes present, the
*singular* `findByText(/review/i)` throws on ambiguity, not on absence.

**Fix (deviation from the brief's literal code):** replaced the nested `<title>` element
with an `aria-label` attribute on the `<circle>` — `aria-label={`${mk.kind}: ${mk.name}`}`.
This keeps an accessible name for the marker (screen readers / some AT can still read
`aria-label` on an SVG shape) without adding a second visible text node that collides with
the rail. No other change to the component's behavior, markup structure, or CSS classes.

**GREEN** — re-ran: `2 passed (2)`; full suite: `86 passed | 457 tests passed`.

This is the one place I diverged from the brief's copy-pasted code, and it was a genuine
test/component mismatch in the brief itself rather than an escalation-worthy field/shape
mismatch (no `HygieneReport` field or `buildTimeline` return-shape issue — those matched
exactly), so I fixed it in place rather than stopping.

## CSS tokens added (single `:root` block, `packages/console/src/shell/theme.css`)

The app is single-theme (warm paper, no dark mode / no `prefers-color-scheme` block) — I
did not add a dark variant, per the brief. Added the 8 tokens `toolCategory.ts` and
`ContextTimeline.tsx` already reference, inserted right after the existing `--gold` /
`--line` block:

```css
--blue: #3f6b8a;       /* context-window chart line */
--green: var(--emerald);   /* alias — matches the existing "certified" green */
--slate: #6b6558;      /* bash */
--purple: #6b4a7a;     /* skill */
--pink: #a85a72;       /* agent */
--amber: var(--gold);  /* alias — matches the existing warn/gold */
--teal: #3f7a72;       /* task */
--red: var(--accent);  /* alias — matches the existing terracotta/.obs-error */
```

`--green`/`--amber`/`--red` alias existing tokens (`--emerald`/`--gold`/`--accent`) rather
than minting parallel hex values with the same meaning, since this app already uses those
three for exactly "success / warn / danger". `--blue`, `--slate`, `--purple`, `--pink`,
`--teal` are new muted, desaturated hues picked to sit next to `--paper`/`--raised`
(#f1eadb / #fbf7ee) and `--ink-soft` (#463d2c) without reading as neon — verified all 8
resolve (`grep -c -- "--<token>:" theme.css` → 1 each, only definition site is `:root`).

## Layout CSS added

Added after the existing `.hyg-factors` rules: `.ct` (grid `1fr 288px`, wraps to a single
column under 880px via `@media (max-width: 880px)`), `.ct-chart`, `.ct-scroll`
(`overflow-x: auto` so the wide SVG scrolls instead of blowing out the card), `.ct-rail`
(`overflow-y: auto`, `max-height: 420px` — so a tall rail never stretches the card),
`.rail-h` (section labels, reuses the `.hyg-head`-style uppercase/muted look), `.ct-facs`
(same shape as `.hyg-factors`, new name per the brief), `.jump`/`.jbadge`/`.jbody` (the
jump rows). Reused the existing `.hyg-verdict`/`.hyg-score`/`.hyg-word`/`.is-bounded`/
`.is-mixed`/`.is-bloated` classes for the verdict badge — no new verdict-color CSS needed.

## The swap

`packages/console/src/panels/Observe/TranscriptViewer.tsx`:
- import changed from `HygieneReport` to `ContextTimeline` (`./ContextTimeline.js`)
- the render line (was ~76) now reads:
  `{view && <ContextTimeline apiBase={apiBase} agent={agent} sessionId={view.sessionId} />}`
- `ProcessQualityReport`, `DistillSection`, and the turn tree below are untouched.

`HygieneReport.tsx` / `HygieneReport.test.tsx` / `_shared/BloatCurve.tsx` were left in the
tree exactly as instructed (HygieneReport still backs the cross-session leaderboard
elsewhere) — nothing in them was modified or deleted.

## Verification

- `pnpm --filter @agentgem/console test -- ContextTimeline` → 2/2 pass.
- `pnpm --filter @agentgem/console test` (full suite) → **86 files / 457 tests, all pass**
  (includes the pre-existing `HygieneReport.test.tsx`, `TranscriptViewer.test.tsx`,
  `toolCategory.test.ts`, `ctxTimeline.test.ts` — none broke).
- `pnpm --filter @agentgem/console exec tsc --noEmit` → clean, no output.

## Files changed

- `packages/console/src/panels/Observe/ContextTimeline.tsx` (new)
- `packages/console/src/panels/Observe/ContextTimeline.test.tsx` (new)
- `packages/console/src/panels/Observe/TranscriptViewer.tsx` (import + render swap, 4-line diff)
- `packages/console/src/shell/theme.css` (8 category tokens + `.ct*`/`.rail-h`/`.jump*` layout rules)

Note: `.superpowers/sdd/task-5-report.md` showed as modified in `git status` before this
task started (not something I touched) — excluded from this task's commit.
