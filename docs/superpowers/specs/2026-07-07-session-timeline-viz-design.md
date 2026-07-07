# Session Timeline Visualization — design

**Date:** 2026-07-07
**Status:** approved for planning
**Home:** History → Session (`#/sessions/<agent>/<sessionId>`) → `TranscriptViewer`

## Problem

The per-session drill-down (`TranscriptViewer`) is a linear, text-heavy turn→span
tree. You can *read* a run but you can't *see* its shape: where context blew up,
which skill or subagent preceded a jump, how token spend is distributed across the
work. The four dimensions people actually want at a glance — **context window,
skill use, tool use, token usage** — are all readouts of the same ordered turn
sequence, but nothing plots them together.

A real 866-turn session that climbed to 833k context tokens made this concrete
(mockups in scratchpad, validated against real `.jsonl`): a single shared
turn-axis with the context curve as the hero and skill/subagent/prompt events
marked on it is dramatically more legible than the current curve-less tree.

## Goal

Two complementary lenses inside the existing `TranscriptViewer`, driven by data
that is **already on the wire** (plus one small server-side field):

1. **① Context timeline (primary).** The hygiene block, upgraded: context-window
   area chart over turn index, danger/caution bands, event markers (skill ◆,
   subagent ▲, user prompt •), an output-tokens/turn micro-strip, and a right rail
   ranking the biggest context jumps by likely cause. The existing hygiene verdict
   + fired-factor chips fold into that right rail.
2. **② Structure map (drill-down).** A `Map ⇄ Transcript` toggle on the turn view.
   **Map** (default) groups the run into phases (one per user prompt) and renders a
   per-phase flamestrip of tool/skill calls colored by kind, with a peak-context
   bar and skill/subagent pills. **Transcript** is the current verbatim turn tree,
   unchanged, for when you need the actual text.

Non-goals: no new screen, no new route, no cross-session compare (the diff engine
stays dormant as today), no Tier-2 LLM analysis. Share/teach export (mockup view ③)
is explicitly deferred — it falls out of the same phase aggregates and can be a
later follow-up.

## Data — what exists vs. what changes

| Need | Source | Status |
|---|---|---|
| Context/token curve | `hygieneRoute.curve: [{turn, msgIndex, ctxTokens, cacheCreation, outTokens}]` | ✅ already returned |
| Hygiene verdict + factors | `hygieneRoute.hygiene` + `.factors` | ✅ already returned |
| Per-turn tool/skill/agent **markers** | `SessionSequence.steps: ProcedureStep[]` (`{tool, msgIndex}`) | ⚠️ available server-side, **not yet joined into curve** |
| Phase boundaries + verbatim turns | `inspectSessionRoute` → `TranscriptView.turns[].spans[]` (`message` / `tool_call`) | ✅ already returned |
| Aggregate tool counts | `SessionSummary.events.toolCalls` | ✅ already returned |

### The one server change: enrich `curve` points with an event tag

`buildHygieneReport(signal)` (`src/sessionHygieneCore.ts`) already holds the
`SessionSequence`, which carries **both** `contextSeries` (→ `curve`) and
`steps: ProcedureStep[]`. Both are keyed by `msgIndex`. So add an optional event
tag per curve point via a local join — no new scan, no new route:

```ts
// HygieneReportSchema.curve element — additive, all optional (back-compat):
{ turn, msgIndex, ctxTokens, cacheCreation, outTokens,
  event?: { kind: "tool" | "skill" | "agent", name: string } }
```

Join rule in `buildHygieneReport`: index `steps` by `msgIndex`; for each curve
point, attach the step at that `msgIndex` if present. Classify:
`Skill` → `skill` (name from step detail if captured, else `"skill"`);
`Task`/`Agent` → `agent`; anything else → `tool` with the tool name. When a turn
has multiple steps, prefer skill > agent > tool (the interesting event wins).
Mirror the additive field in `packages/console/src/api/routes.ts`
`HygieneReportSchema` so client and server schemas stay identical (house rule).

If skill/subagent *names* turn out not to be captured in `ProcedureStep` detail,
degrade to generic `skill` / `agent` markers — the category is what drives the
chart; the name is a tooltip nicety. Verify during implementation, don't block.

## Component architecture

All changes live under `packages/console/src/panels/Observe/` (rendered by
`Sessions/index.tsx` via `TranscriptViewer`). No route/nav changes.

```
TranscriptViewer (existing shell — head, meta, back button)
├─ ContextTimeline        ← NEW; REPLACES the <HygieneReport> block
│   ├─ ctx area chart (SVG, viewBox-scaled, horizontal-scroll for long runs)
│   │   · danger/caution bands · event markers · output-token micro-strip
│   └─ right rail: verdict badge + fired-factor chips + ranked context jumps
├─ ProcessQualityReport   ← unchanged
├─ DistillSection         ← unchanged
└─ StructureView          ← NEW; WRAPS the turn area with a Map ⇄ Transcript toggle
    ├─ "Map" (default): PhaseFlamestrip[]  ← phases from user-prompt spans
    └─ "Transcript": existing <ol.tv-turns> turn→span tree (moved, not rewritten)
```

### New units (each independently testable, pure where possible)

- **`ctxTimeline.ts`** — pure: `(curve) → { points, bands, markers, jumps }`.
  `jumps` = top-N positive `ctxTokens` deltas with cause derived from the point's
  `event` tag (fallback: large `cacheCreation` → "context injection"). No DOM.
- **`ContextTimeline.tsx`** — fetches `hygieneRoute` (as `HygieneReport` does
  today), renders SVG chart + right rail. Claude-only guard preserved (returns the
  current "hygiene unavailable for codex" state).
- **`phases.ts`** — pure: `(TranscriptView) → Phase[]`, where a `Phase` splits at
  each user `message` span and carries `{ label, turns, tools[], peakCtx?, out,
  skills[] }`. Reused by Map view. Unit-tested on a fixture transcript.
- **`PhaseFlamestrip.tsx`** — renders one phase: header (label + stats), skill/
  agent pills, peak-context bar, run-length-collapsed tool cells colored by
  category.
- **`StructureView.tsx`** — owns the `Map ⇄ Transcript` toggle state; renders
  `PhaseFlamestrip[]` or delegates to the existing turn tree.

### Category → color (shared constant, both views)

`read`(Read/Grep/Glob/LS/ToolSearch)=blue · `write`(Write/Edit)=green ·
`bash`=slate · `skill`(Skill)=purple · `agent`(Task/Agent)=pink ·
`ask`(AskUserQuestion)=amber · `task`(TaskCreate/Update)=teal · else=muted.
Put the map + `catOf(tool)` in one module (e.g. `toolCategory.ts`) so timeline
markers and flamestrip cells never drift.

## Error / edge handling

- **Codex sessions:** ① renders the existing hygiene-unavailable state (curve is
  Claude-only). ② Map still works — it needs only tool ordering from
  `TranscriptView`, which exists for both agents.
- **Empty/short sessions:** `curve.length < 2` → skip the chart, show a one-line
  "not enough turns to chart" note (mirrors current empty-turns handling). Phases
  with zero tool calls render header-only (no empty strip).
- **Missing `event` tag (old cache / pre-enrichment scans):** markers simply don't
  render; chart + jumps still work off `ctxTokens`/`cacheCreation`. Fully
  back-compat because the field is optional.
- **Very long runs (800+ turns):** chart uses a `viewBox` with min-width and a
  horizontal-scroll container; markers are drawn only for skill/agent/prompt events
  (not every turn) to avoid clutter — same approach validated in the mockup.
- **Right-rail height vs. chart:** the folded rail stacks verdict + hygiene factors
  + ranked jumps, so on a heavily-bloated session it can grow taller than the chart,
  and on a short/clean session it can look sparse next to it. Cap the jumps list
  (top ~4) and the factors list to fired-only; if the rail still overflows the
  chart height, let it scroll within its own column rather than stretching the card.
  On narrow viewports the rail wraps below the chart (already the grid fallback), so
  this only matters at the two-column breakpoint.

## Testing

- `ctxTimeline.test.ts` — deltas/jumps ranking; cause fallback when `event` absent;
  band thresholds; empty-curve guard.
- `phases.test.ts` — split at user prompts; tool/ skill aggregation; a continued
  (no-prompt) tail folds into the prior phase.
- `toolCategory.test.ts` — every known tool maps to its category; unknown → other.
- Server: extend `sessionHygiene.test.ts` to assert `curve[i].event` is populated
  for a fixture turn that invokes a skill and one that spawns a subagent, and that
  the field is absent (not null) when a turn has no step.
- Component smoke tests (React) for `ContextTimeline` (renders chart + rail from a
  fixture `HygieneReport`) and `StructureView` (toggle flips Map/Transcript).
- Run the **full** console suite (hardcoded-count tests exist elsewhere) and the
  root suite (CI gates on root, not console).

## Rollout / surface

Single PR off freshly-fetched `origin/main`. Behavioral change is confined to
`TranscriptViewer`'s composition + the additive `curve.event` field. Console tests
aren't in CI — run locally; root `test (24)`/`test (26)` gate the server change.

## Open questions (decide in implementation, none blocking)

1. Does `ProcedureStep` detail carry the **skill/subagent name**? If yes, surface
   it in marker tooltips + jump causes; if no, generic category markers.
2. Jump **cause attribution look-back**: same-turn `event` only (simpler) vs. a
   1–2 turn look-back (a Read that inflates the *next* turn's cache). Start
   same-turn; note the limitation in the rail if it reads oddly on real sessions.
