# Context-Hygiene Detectors — design

**Date:** 2026-07-06
**Status:** Draft for review
**Package:** `packages/insight`
**Prototype:** `mockups/context-bloat-report.html` (retrospective readout, validated on 4 real transcripts), `mockups/ember-session-game.html` (Phase 2 live-nudge mechanic)

## Problem

A session that does one bounded task over many turns is fine. A session that **drags many unrelated tasks** into one ever-growing window is not: the context pins the model's cap, every subsequent turn re-processes the whole history, and answer quality degrades exactly when the window is fullest. Today AgentGem has no signal for this. `insight`'s detector family flags *retry storms* and *thrash loops* within a task, but nothing measures whether the **session itself** should have been cut into cleaner boundaries — and nothing quantifies the token waste of not cutting.

We validated the phenomenon is real and measurable with **zero LLM calls** by scanning 4 real transcripts:

| Session | Turns | Wall-clock | Task clusters | Retry storms | Late/early cache churn | Input tokens re-billed |
|---|---|---|---|---|---|---|
| 6165002d | 3,953 | 53 hrs | **11** | 8 | 0.66× | **2.05 B** |
| 26df3b24 | 3,385 | 23 hrs | 2 | **17** | **2.5×** | 1.92 B |
| d75d0fc9 | 1,451 | 8.9 hrs | 3 | 0 | 1.29× | 0.74 B |
| e60fb8db | 488 | 2.9 hrs | 2 | 0 | 0.56× | 0.12 B |

`d75d0fc9` is the control: long (8.9 hrs) but **bounded** — 3 clusters, zero retry storms. The smell is not length; it is unbounded task-mixing correlated with a pinned window and a late-session quality drop.

## Goal (this spec)

Ship a **retrospective** context-hygiene detector family in `packages/insight` that:

1. Computes the per-turn **context-size series** from transcript `usage` accounting (ground truth, deterministic).
2. Emits `DetectorFinding`s for a small set of cheap, pure detectors: cap-pinning, task-cluster sprawl, task-switch ping-pong, re-read churn, and late-session cache churn.
3. Surfaces them through the **existing** `runDetectors → summarizeFindings → rubricReport` path, so the Insights/scorecard UI picks them up with no new rendering plumbing.
4. Reserves one `cost: "llm"` confirmer detector (semantic task-boundary + degradation verdict) as a *threshold-gated* follow-up, not a scanner.

**Explicit non-goals (this spec):** the live SSE nudge surface and the EMBER game (Phase 2, separate spec — see Deferred). No changes to how sessions are scanned beyond adding the token series. No new HTTP endpoint — we reuse the rubric/insights report surface.

## Key design decision: how per-turn context reaches a pure detector

The house pattern is `DetectorSpec.detect(session: SessionSequence, signal) => DetectorFinding[]` — a **pure** function over the scrubbed verb spine. But `ProcedureStep` (`tool/verb/arg/msgIndex`) carries **no token data**, and `runDetectors` only sees `signal.sequences?.sessions`. The bloat curve needs per-turn context size, which lives in the raw transcript's `usage` block — the same fields `observeScan.ts:57-61` already reads (`input_tokens + cache_read_input_tokens + cache_creation_input_tokens`) but folds into totals.

**Options considered:**

- **A — Enrich `SessionSequence` with an optional token series (chosen).** During scan (when `retainSequences` is on), attach `contextSeries?: TurnUsage[]` to each `SessionSequence`. Detectors stay pure `session → findings`; the registry, the `cost` seam, the privacy contract (numbers only, never `arg`), and the whole `runDetectors → summarize → rubricReport` path are unchanged. New detectors simply read `session.contextSeries` and degrade to `[]` when it's absent (older scans, spine-only mode).
- **B — A parallel non-detector analyzer** that reads `usage` directly and emits its own findings. Rejected: forks the pattern, duplicates the aggregation/report path, and the `cost: cheap|llm` funnel stops being the single organizing seam.
- **C — Put tokens on `ProcedureStep`.** Rejected: tokens are a per-*turn* (assistant message) property, not a per-*tool-call* property; several tool calls share one turn's usage. Wrong granularity, and it bloats every step.

Option A localizes the change to one optional field and one scan-time computation, and keeps detectors testable in isolation with hand-built series.

## Data model

```ts
// workflowScan.ts — new, optional, computed only when retainSequences is on
export interface TurnUsage {
  turn: number;            // 0-based assistant-message index within the session
  msgIndex: number;        // transcript coordinate (provenance, mirrors ProcedureStep)
  ctxTokens: number;       // input_tokens + cache_read + cache_creation  (the curve)
  cacheCreation: number;   // cache_creation_input_tokens alone (the churn signal)
  outTokens: number;       // output_tokens (cheap secondary signal)
}

export interface SessionSequence {
  steps: ProcedureStep[];
  missionHint?: MissionHint;
  sessionId: string;
  transcript: string;
  atMs: number;
  model?: string;
  contextSeries?: TurnUsage[];   // NEW — undefined for spine-only / legacy scans
}
```

Population lives beside the existing usage read: a small pure helper `usageSeries(rawMessages) => TurnUsage[]` in the scan path, unit-tested against fixture transcripts. It reuses the exact field set `observeScan.ts` already trusts, so there is one definition of "context size."

**Model cap.** The cap (≈1M for the `[1m]` context, ≈200k otherwise) is read from `session.model` via a tiny lookup with a safe default; "pinned" is `ctxTokens / cap`. No hardcoded 1M in a detector body.

## Detectors (Tier 1 — `cost: "cheap"`, always on)

Each is a `DetectorSpec` added to `DETECTORS`. All are pure, degrade to `[]` on missing data, and emit `detail` from **counts and low-cardinality verbs only** — never `arg` (the existing privacy contract). IDs are open kebab strings, consistent with the module comment.

| id | fires when | detail (coordinates + counts only) | severity |
|---|---|---|---|
| `context-pinned` | ≥`PIN_FRACTION` (0.9) of turns sit above `PIN_LEVEL` (0.85·cap) | `"pinned N/M turns at ≥85% cap"` | warn |
| `task-sprawl` | distinct `arg` path-clusters ≥ `SPRAWL_MIN` (5) in one session | `"K task clusters in one session"` | warn |
| `task-pingpong` | cluster transitions ≥ `SWITCH_MIN` (12) over the session | `"S switches across K clusters"` | info |
| `reread-churn` | same `file_path` read ≥ `REREAD_MIN` (3) times | `"F files re-read ≥3× (W redundant reads)"` | info |
| `cache-churn-late` | `cacheCreation` late-half ÷ early-half ≥ `CHURN_RATIO` (1.8) | `"late cache re-creation R× early"` | warn |

`context-pinned` and `cache-churn-late` require `contextSeries`; the other three run on the existing spine (`task-sprawl`/`task-pingpong` need arg-cluster bucketing, `reread-churn` needs the `Read` step's file arg — both already present in `ProcedureStep`). Cluster bucketing (`packages/<x>` / top-dir / ext) is a shared pure helper so sprawl and pingpong agree on "what a task is."

Constants are exported (like `RETRY_STORM_MIN`) so `detectorRules.ts` authors and tests can reference them, and thresholds are tunable in one place.

### Composite: the hygiene score

`rubricReport` already turns `DetectorSummary[]` into a factor list. We add a derived **hygiene score** (0–100) as a pure function of the five findings (weights mirror the prototype's `score()`), so the report/scorecard can show one headline number and a `bounded / mixed / bloated` verdict alongside the individual factors. This is presentation-layer aggregation over existing findings — no new detector, no new data.

## Tier 2 — `cost: "llm"` confirmer (threshold-gated, deferred within this spec)

One spec, one detector: `session-boundary-judge`. It does **not** scan — it only runs when Tier 1 crosses a gate (e.g. `task-sprawl` fired **and** `context-pinned` fired). Given the cheap findings' coordinates, it asks the model two things the deterministic tier structurally cannot answer:

- **Semantic boundary** — were those K path-clusters one task or genuinely separable tasks? (Turns a *structural* split into "cut *here*.")
- **Degradation verdict** — sampling early vs late turns, did answer specificity actually drop, and does the drop line up with the bloat curve?

Output is one `DetectorFinding` carrying the canonical `advice` ("this looked like 3 tasks — a `/clear` around turn N, or a subagent for the second, would have kept each window lean"). It rides the same `cost: "llm"` reservation the `DetectorSpec` type already documents. **Implementation of Tier 2 is out of scope for the first plan** — Tier 1 lands and proves value first; the gate + judge is a fast follow.

## Flow

```
scan (retainSequences) ──► SessionSequence{ steps, contextSeries }
        │
        ▼
runDetectors(signal, [context-pinned, task-sprawl, task-pingpong,
                      reread-churn, cache-churn-late])
        │  (pure, per-session, try/catch-isolated — unchanged)
        ▼
summarizeFindings ──► DetectorSummary[]  ──►  rubricReport
        │                                        │
        │                                        ├─ existing factor list
        └────────────────► hygieneScore() ──────► + headline score/verdict
```

Nothing downstream of `runDetectors` changes shape; the new detectors are just five more specs and one optional field feeding them.

## Testing

- **`usageSeries` unit tests** against small fixture transcripts (including a spine-only session → `contextSeries` undefined → dependent detectors return `[]`).
- **Per-detector pure tests**: hand-built `SessionSequence`s at threshold boundaries (K=4 vs 5 clusters, ratio 1.79 vs 1.81) — the honest edge cases, not trivial ones.
- **`hygieneScore` monotonicity**: bounded control (`d75d0fc9`-shaped) scores ≥ mixed ≥ bloated; a long-but-bounded fixture must **not** be flagged (guards the core thesis).
- **Broken-detector isolation**: a spec that throws yields `[]` and never kills the run (mirrors `runDetectors`' existing contract).
- Follows `packages/insight` test placement; no console/CI-gap surprises (console tests aren't in CI — this is all in `insight`, which is).

## Privacy

Findings carry `evidence.msgIndices` + count-based `detail` only, identical to `DetectorFinding` today. The token series is pure integers. No path, no `arg`, no content ever enters a finding — the same contract that lets detector output leave the machine safely.

## Deferred / Phase 2 (separate spec)

- **Live nudge surface.** The same five signals computed on a **streaming buffer** off the console **Watch SSE feed** (`packages/console/src/panels/**/‌*Stream.ts` infrastructure already exists), emitting a break/cut nudge when Tier 1 gates trip mid-session. Prospective twin of this retrospective pass.
- **EMBER** (`mockups/ember-session-game.html`) — the gamified framing where banking a clean cut is the high score and overstaying burns out. Product/UX decision, not engine work.
- **Tier 2 `session-boundary-judge`** implementation (designed above, gate + judge).
- **`detectorRules.ts` context-hygiene pack** — expose the cluster/threshold detectors as declarative rules so users/Gems can tune them without code.
```
