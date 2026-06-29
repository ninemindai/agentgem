# Mine panel v2 — streamed scan + cache + select-to-Gem

_Addendum to `2026-06-28-goldmine-scorecard-design.md`. Turns the read-only scorecard hero
("Mine" panel) into the actionable on-ramp: a **streamed** scan with live-climbing counts, a
**cached** result, and a **selectable list of discovered workflows** the user picks and
**distills into a Gem**. All three decisions confirmed with the user 2026-06-28._

## Motivation

The scorecard scan takes ~24s (12 recent projects) and currently shows a static "Scoring…"
skeleton, recomputes on every visit, and ends in a read-only counts hero. v2:
1. **Stream** per-project progress + live-climbing counts (no dead 24s wait).
2. **Cache** the result (transcript-token keyed) → instant on revisit.
3. **List** the discovered workflows as a selectable set → **distill selected → skills → Gem**
   (the strategy's "every score component funnels into distill/sell", made literal).

## 1. Streaming

New SSE endpoint, mirroring the shipped `/api/workflow/analyze/stream` (raw Express +
`originGuard`, registered in `src/index.ts`, NOT via the `@get` decorator):

`GET /api/scorecard/stream` emits named events:
- `start` `{ total: number }` — number of projects to scan (≤12).
- `progress` `{ done, total, label, partial: { breadth, battleTested, portable } }` — after
  each project, the **running aggregate** so the UI's counts climb live.
- `done` `{ scorecard: Scorecard, cached: boolean }` — final result.
- `failed` `{ message }`.

The plain `GET /api/scorecard` stays (tests / non-stream callers) and shares the cache + core.

**Core refactor:** `collectScorecard` gains an optional `onProgress?(p: ScorecardProgress)`
callback invoked after each project with the running aggregate (computed by `aggregateScorecard`
over the loads-so-far). The discover→sort→cap project selection is unchanged.

## 2. Caching

Reuse the existing token/cache helpers (`src/gem/analysisCache.ts`: `transcriptToken`,
`readAnalysisCache`, `writeAnalysisCache`) under a synthetic root `"__scorecard__"`.

- Token = `transcriptToken(allScannedTranscriptPaths)` over the top-12 projects' transcripts —
  auto-invalidates when any scanned session changes (same semantics as analyze).
- `GET /api/scorecard` and the stream both: token → cache hit returns/emits instantly; miss
  computes, then `writeAnalysisCache("__scorecard__", token, scorecard)`. Degraded results are
  NOT cached (match analyze's rule).

## 3. Selectable workflow list → Gem

### Payload change
`ProjectGoldmine` gains a fuller, selectable workflow list (replaces the top-5-names-only
`topCandidates`):

```ts
type WorkflowItem = { key: string; name: string; confidence: "high"|"medium"|"low"; portable: boolean };
type ProjectGoldmine = {
  root: string; label: string;
  breadth: number; battleTested: number; portable: number;
  workflows: WorkflowItem[];   // up to WORKFLOWS_PER_PROJECT (e.g. 12), confidence-ranked
};
```
`key` is the existing `ProcedureCandidate.key` (stable per project) — the handle the build step
re-locates the candidate by. Both server and console `ScorecardSchema` update in parity.

### Build endpoint
`POST /api/scorecard/build` — body `{ selections: { root: string; keys: string[] }[], name?: string }`.
For each `root`: re-scan (`scanWorkflow` + `extractCandidates`, reusing the per-project loader),
filter candidates to the selected `keys`, **distill each** via the existing `distillWorkflow`
(LLM with heuristic-skeleton fallback) → `DistilledSkill[]`, write each as a draft `SKILL.md`
(reusing the `/api/workflow/draft` write path → `~/.agentgem/distilled/<name>/`), then compose
the drafted skills into a Gem via the existing `buildGem`. Returns the built Gem (same shape as
the existing build path).

- Distillation runs **only on this build action** (opt-in), so the scan/scorecard stays
  deterministic (no LLM) per the original constraint.
- Reuses `distillWorkflow`, the draft-write path, and `buildGem` — no new Gem machinery.

### Mine panel UI
- During scan: progress bar `k/total · <project>` + the three counts climbing live (from
  `progress` events).
- On `done`: the counts hero + a **selectable list** of workflows grouped by project
  (checkboxes; portable/battle-tested badges), and a **"Build Gem"** button (enabled when ≥1
  selected) → `POST /api/scorecard/build` → success/download.
- Cache hit → near-instant `done` (skip straight to hero + list).

## Reuse map (no new core machinery)

| Need | Reuse |
|---|---|
| SSE plumbing | `streamWorkflowAnalyze` pattern (`workflowStream.ts`) + `originGuard` |
| EventSource client | `analyzeStream.ts` `openAnalyzeStream` pattern |
| cache | `analysisCache.ts` token + read/write |
| per-project scan | `defaultScorecardDeps.loadProject` (already extracts candidates) |
| distill workflow → skill | `distillWorkflow` (`distill.ts`) + heuristic fallback |
| write skill draft | the `/api/workflow/draft` write path |
| compose Gem | `buildGem` (`src/gem/targets.ts` / build path) |

## Out of scope / follow-ups
- The scan-once + bucket-by-cwd + async refactor (retires the 12-project cap + most latency) —
  still the priority perf follow-up from the base scorecard spec; orthogonal to streaming.
- Precise candidate→artifact portability via provenance (the spec's portability follow-up).
- Multi-project Gem naming/curation polish; trophy unchanged.

---

## Milestone C — share the built Gem via an OG card (user decision, 2026-06-28)

Sharing is reframed from a local badge to a hosted OpenGraph/Twitter-Card so X / Facebook /
LinkedIn auto-render a rich preview. The card subject can be **either of two things** (user
decision 2026-06-28):

1. **A Gem** (the Milestone-B artifact) — card = generated image + the Gem's value framing +
   **link to the Gem (install/try)** + invite CTA. Drives *supply/usage* virality. Depends on B.
2. **A report card / certificate** (the goldmine achievement itself) — card = generated image +
   the asset-framed counts/credential ("distilled from N battle-tested workflows") + invite CTA.
   Drives *identity/status* virality. **Independent of B** — it shares the scorecard, so it can
   ship first. Revives the deferred "certificate" follow-up from the base scorecard spec.

Both share the same OG-card + social-intent mechanism (below); they differ only in subject and
whether a Gem install-link is present. Replaces the local-only canvas trophy as the primary share
path (trophy stays as an offline fallback image).

Open design points (to detail when B is near):
- **Hosting:** OG cards require a public URL. Reuse/extend the existing Gem share/registry +
  publish infra for the landing + OG image; needs a deploy to verify real previews (localhost
  can't be fetched by the platforms). A privacy pass on what the public Gem page exposes.
- **Card content:** Gem name + what-it-does + provenance ("distilled from N battle-tested
  workflows") + generated image + install link + invite CTA. Aggregate/curated — not the raw log.
- **Channels:** per-platform share intents (x.com/intent, linkedin sharing, facebook sharer)
  pointing at the hosted Gem page; native `navigator.share` fallback.
- **Roadmap:** this is the Phase-4 social-share / viral-acquisition loop pulled forward.
