# Goldmine Scorecard — design

_Spec 2026-06-28. Phase-1 acquisition-funnel feature from the biz roadmap
(`agentgem-biz/strategy/product-view-and-roadmap.md` §Phase 1; `goldmine-assessment-scorecard.md`).
Scores the **asset** (the goldmine in your session logs), not the **person**. Built almost
entirely by aggregating signals the existing analyze pipeline already produces._

## Goal

Turn the "mirror moment" into a concrete, in-app artifact: assess a user's local agent session
logs and show **what their working log is worth** as reusable capability — framed as an asset,
diagnostic (every number funnels into action), local-first, and opt-in shareable.

Success criterion: a user opening the Observe panel sees, with no signup and no network, a hero
that reads like _"Your log holds 14 reusable workflows — 3 battle-tested, 5 worth sharing,"_
where each count links into the existing distill flow, and can export an aggregate-only trophy.

## Non-goals (v1)

- **No dollar figure.** Counts only. A `$` estimate waits for real marketplace price data
  (avoids the inflation trap the strategy doc warns about).
- **No person/skill grade.** Score the asset, never the miner.
- **No comparative/percentile/leaderboard.** Those need a comparison population (the data moat)
  and must be gated on proof-of-paid-use. Absolute, personal score only in v1.
- **No new transcript parsing.** Reuse `workflowScan` / `extractCandidates` verbatim.

## Reuse map — what already exists

The scorecard is ~80% an aggregation + presentation pass over the shipped analyze pipeline. The
maturity heuristic the strategy doc asks for ("recurrence × stability") already exists.

| Building block | Existing location | Role in scorecard |
|---|---|---|
| `discoverProjects(dirs)` | `src/gem/testbedFlavors.ts` | enumerate all projects from Claude/Codex session history |
| `introspectProject(root)` / `introspectAll` | `src/gem/introspect.ts` | build the `ScanInventory` per root |
| `scanWorkflow(paths, inv)` | `src/gem/workflowScan.ts` | transcripts → `WorkflowSignal` (deterministic) |
| `extractCandidates(signal, inv)` | `src/gem/extract.ts` | gated candidates + `priorConfidence` |
| `scoreCandidate()` | `src/gem/extract.ts:103` | maturity = mission-clarity × recurrence → high/medium/low |
| `extractReflections(signal)` | `src/gem/extract.ts` | deterministic gaps (unresolved-task / recurring-pattern) |
| `recommendWorkflow(signal, inv)` | `src/gem/acpRecommender.ts` | LLM-enriched gaps + candidates (on-demand drill-in) |
| `/api/workflow/analyze/stream` | `src/workflowStream.ts` | existing SSE flow reused for per-project enrich |
| Observe panel + `/api/observe` | `packages/console/src/panels/Observe`, `src/gem.controller.ts` | host surface for the hero |
| Curate > Analyze distill flow | `packages/console/src/panels/Curate` | the distill CTA target |

## Architecture & data flow

```
discoverProjects(dirs)                      [existing]
  └─ for each project root:
       introspectProject(root)              [existing]
       scanWorkflow(transcripts, inv)       [existing]  → WorkflowSignal
       extractCandidates(signal, inv)       [existing]  → candidates + priorConfidence
  └─ aggregateScorecard([...perProject])    [NEW: scorecard.ts]  → Scorecard
       │
       ├─ GET /api/scorecard                [NEW route in gem.controller.ts]
       └─ hero in Observe panel             [extend panels/Observe]
            ├─ count clicks → Curate>Analyze distill flow   [existing]
            ├─ project drill-in → /api/workflow/analyze/stream → recommendWorkflow  [existing, LLM]
            └─ "Share goldmine" → canvas trophy (aggregate-only, local)  [NEW]
```

- **Deterministic core** (no LLM, no network): paints on first load. This is the day-one,
  local-first, ownership-safe value.
- **Hybrid enrich** (on click, per project): reuse the existing analyze stream → `recommendWorkflow`
  for LLM-quality gaps + candidates on the project the user drills into. No new LLM plumbing.
- **The only genuinely new code:** `scorecard.ts` (aggregator), one route, one React hero, one
  canvas trophy.

## Data shape

```ts
type Scorecard = {
  breadth: number;        // distinct reusable workflows surfaced (deduped by verb-spine across projects)
  battleTested: number;   // mature: priorConfidence === "high" (mission clarity × recurrence > floor)
  portable: number;       // general enough to share / show off / sell (travels beyond origin repo)
  gaps: string[];         // deterministic v1 (extractReflections); LLM-upgraded on drill-in
  projects: ProjectGoldmine[];   // per-project breakdown, ranked; IN-APP ONLY (never on trophy)
  generatedAtMs: number;
  degraded: boolean;      // true if any project's signal was partial
};

type ProjectGoldmine = {
  root: string;
  label: string;          // basename for display
  breadth: number;
  battleTested: number;
  portable: number;
  topCandidates: { name: string; confidence: "high" | "medium" | "low" }[];
};
```

### Count definitions (each maps to an existing field — no new analysis)

| Count | Definition | Source |
|---|---|---|
| **breadth** | distinct gated procedure candidates across all projects, deduped by verb-spine | `extractCandidates().candidates` |
| **battleTested** | candidates with `priorConfidence === "high"` | `scoreCandidate()` (`extract.ts:103`) |
| **portable** | `battleTested` ∩ general: workflow whose artifacts aren't all project-local — uses portable skills/MCP tools (`ArtifactUsage.root === null`), not just repo-only `Edit`/`Bash` | `ArtifactUsage.root` |
| **gaps** | v1 deterministic from `extractReflections()`; upgraded to `WorkflowAnalysis.gaps` on drill-in | `extract.ts` / `acpRecommender.ts` |

**On "portable" (the key reframe):** the third tier is not "sellable" but **"travels beyond the
repo it was born in"** — which is what makes a workflow worth sharing, showing off, *or* selling.
This matches the strategy ladder **reuse → share → sell** (`liberating-story` "selfish first
rung"; rings of reach: team → infra → world). The `root === null` proxy literally measures
portability, so it is honest to display, not a sellability guess. The CTA fans out to the whole
ladder (distill → reuse locally · share with team · later list), keeping v1 in the
"value-before-monetization" tone the `recommendation-engine` doc requires.

## UI — Observe hero

The scorecard renders as the **hero header of the existing Observe panel** (which already
aggregates all sessions across all projects). Below it, the existing pulse / daily chart /
facets are unchanged.

- Hero copy (count-only, asset-framed): _"Your log holds **14 reusable workflows** — **3
  battle-tested**, **5 worth sharing**."_
- Each count is a link: `battleTested` / `portable` → the matching project's
  **Curate > Analyze** distill flow (the existing UI). Satisfies the "no pure-viewer funnel"
  rule by reusing shipped distill UI.
- Clicking a project row triggers the on-demand LLM enrich (existing analyze stream) to replace
  deterministic gaps with `recommendWorkflow` gaps for that project.
- A **"Share your goldmine"** button exports the trophy (below).

## Trophy / share artifact

Phase-4 social-share work pulled into v1 as an aggregate-only, local, opt-in export.

- **Privacy rule (load-bearing):** _share the trophy, not the goldmine._ The exported artifact
  carries **aggregate counts + tagline + date + AgentGem wordmark** only. It **never** contains
  project names, repo paths, individual workflow names, or any raw transcript content. The
  per-project breakdown stays in-app.
- **Generation:** rendered fully client-side on a `<canvas>` (`fillText` / rects → `toBlob`).
  **Dependency-free** (no `html-to-image`); honors the "stdlib-first" rule. The fixed, simple
  card layout keeps the draw legible. The **data → label mapping** is a separate pure function
  (testable); the canvas draw is thin.
- **Share mechanism:** `navigator.share()` (Web Share API → OS share sheet) with a
  **download-PNG fallback**. No backend, no upload, no account.
- **Opt-in:** never auto-generated or auto-posted; only on the "Share your goldmine" click.
- **Viral hook:** the AgentGem wordmark/handle on the card drives the acquisition loop.

## API

`GET /api/scorecard` → `Scorecard`

- Query (optional): `dir` (override Claude/Codex dirs, for testbed/tests), `projects`
  (JSON-encoded roots to restrict to; default = all discovered).
- Composes `discoverProjects` → per-root `scanWorkflow` + `extractCandidates` → `aggregateScorecard`.
- Deterministic; no LLM. The LLM enrich path reuses the existing
  `GET /api/workflow/analyze/stream?root=…`.

## Testing

- **`scorecard.ts` aggregator** (the heart): unit-tested against synthetic `WorkflowSignal[]`
  fixtures — breadth dedup across projects, `battleTested` from `priorConfidence`, `portable`
  from the `root === null` proxy, `degraded` flag propagation.
- **`/api/scorecard` route**: composition test with `discoverProjects` stubbed; asserts it
  threads discover → scan → aggregate and shape-validates the response.
- **Trophy**: the data → label mapping function is unit-tested; the `<canvas>` pixel draw is
  thin and verified **manually** (pixel snapshots are brittle and not worth it for an ~80-line
  draw — stated honestly per the "if you can't test it, say why" rule).
- **React hero**: light render test that the counts appear.
- **Repo note:** vitest runs compiled tests from `dist/`; clean `dist` after any file
  rename/move before running.

## Out of scope / follow-ups

- Dollar/latent-$ valuation (needs marketplace price data).
- Comparative / percentile / leaderboard scoring (needs data moat + proof-of-paid-use gate).
- Polished/themeable trophy (would justify revisiting the `html-to-image` dep decision).
- Certificate/credential variant of the trophy (the deferred testbed-onramp follow-up).

## Cross-refs

- `agentgem-biz/strategy/goldmine-assessment-scorecard.md` — score the asset, not the person;
  asset-framed components; trophy-not-goldmine; honest-estimate guardrails.
- `agentgem-biz/strategy/recommendation-engine.md` — local-first/heuristic-first bootstrap;
  value-before-monetization tone; extend the `workflow-aware-gem-reco` seed, don't restart.
- `agentgem-biz/strategy/product-view-and-roadmap.md` — Phase 1 acquisition funnel; the distill
  CTA on every top-of-funnel feature (no pure-viewer funnel).
