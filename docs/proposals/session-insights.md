# Session Insights — a `/insights`-style narrative report, reusing the existing engine

_Draft. Base: `origin/main` @ 8f44538 (worktree `agentgem-session-insights`)._

## Goal

Ship a personal **Insights** report that *interprets* a user's coding sessions
(goals, outcomes, friction, recurring workflows) — the qualitative analog of Claude
Code's `/insights` — rather than only *counting* tokens/sessions (which the **Observe**
panel already does). End it with AgentGem's wedge: **"these high-outcome, frequently
re-run sessions are your most valuable Gems — publish them."**

Success criteria:
- A streaming `GET /api/insights/stream` endpoint that scans transcripts, judges each
  session, synthesizes a cross-session report, and streams progress + the final report.
- An **Insights** console panel (in the `observe` group) that renders the report and
  links high-value sessions to the existing publish/Curate flow.
- Graceful degradation: if the agent is unavailable, fall back to a deterministic
  report built from `MissionHint` + meta (mirrors `deterministicAnalysis`).

## How `/insights` works (reverse-engineered from a real run)

Captured from `~/.claude/usage-data/` + an `/insights` invocation in a session
transcript. Three layers:

1. **`session-meta/*.json`** — deterministic per-session aggregation (durations,
   tool_counts, languages, git_commits, tokens, first_prompt, interruptions). *No LLM.*
2. **`facets/*.json`** — **LLM-as-judge, one per session.** Typed verdict:
   `underlying_goal` (prose), `outcome` (enum: mostly/partially/not_achieved),
   `friction_detail`, `brief_summary`, `claude_helpfulness`, `session_type`,
   `primary_success`. **This is the layer that makes it "insightful."**
3. **Synthesis report** — a second LLM pass folds all facets+meta into sections:
   `project_areas`, `interaction_style` (prose), `what_works`, `friction_analysis`,
   `suggestions` (claude_md_additions / features_to_try / usage_patterns),
   `on_the_horizon`, `at_a_glance`. Rendered to a shareable HTML report.

## What AgentGem already has (origin/main)

The engine exists; only the **facet prompt + schema** and the **panel** are new.

| `/insights` layer | AgentGem asset (origin/main) | Action |
|---|---|---|
| transcript scan | `scanWorkflow(paths, inv, {retainSequences:true})` → `WorkflowSignal` (`packages/insight/src/workflowScan.ts`) | reuse |
| goal seed | `MissionHint { task, outcome }` (`workflowScan.ts:29`), `SessionSequence.missionHint` (`:32`) | reuse — already extracted |
| Layer 1 meta | `observeAggregate.ts`, `gem/scorecard.ts` | reuse for framing |
| **Layer 2 facet** | — (engine = `recommendWorkflow`/`distillWorkflow` shape) | **NEW prompt+type** |
| Layer 3 synthesis | `recommendWorkflow` pattern (`acpRecommender.ts:230`) | **NEW prompt**, same plumbing |
| streaming orchestration | `streamWorkflowAnalyze` (`src/workflowStream.ts:27`) | copy pattern |
| agent runner | `connectAcpAdapter` (`packages/base/src/acpSession.ts:55`), `defaultConnectFn` plan-mode + `onDelta` | reuse |
| validate + fallback | `validateAnalysis()` + `deterministicAnalysis()` (`acpRecommender.ts:140/78`) — **hand-rolled TS, no zod** | mirror |
| panel shell | `packages/console/src/panels/Observe`, SSE client `scorecardStream.ts` | copy |

## New code

### 1. `SessionFacet` type — `packages/insight/src/facetTypes.ts`
Plain TS interface (matches the codebase's interface-not-zod convention in
`distillTypes.ts`). Borrow `/insights`' facet fields verbatim:

```ts
export type SessionOutcome = "mostly_achieved" | "partially_achieved" | "not_achieved";

export interface SessionFacet {
  sessionId: string;
  transcript: string;            // basename, provenance (from SessionSequence)
  underlying_goal: string;       // prose
  outcome: SessionOutcome;       // closed enum → enables success-rate math
  friction_detail: string;       // "" when none
  brief_summary: string;
  project: string | null;
  atMs: number;
  origin: "llm" | "heuristic";   // heuristic = deterministic fallback
}
```

### 2. `judgeSessions()` — `packages/insight/src/judgeSession.ts`
Sibling to `recommendWorkflow`/`distillWorkflow`. Consumes `signal.sequences`
(the `MissionHint` substrate), drives the agent once with a batch prompt, returns
typed facets. Same `AcpConnectFn` plumbing, same `validate*` + fallback shape.

```ts
export async function judgeSessions(
  signal: WorkflowSignal,
  opts: { connectFn?: AcpConnectFn; timeoutMs?: number; onDelta?: (c: string) => void } = {},
): Promise<{ facets: SessionFacet[]; degraded: boolean }>;

// fallback (no agent): outcome heuristic from missionHint.outcome text + interruptions
export function deterministicFacets(signal: WorkflowSignal): SessionFacet[];
export function validateFacets(raw: unknown, signal: WorkflowSignal): SessionFacet[];
```

Judge prompt (read-only / plan mode): for each `{task, outcome}` mission, emit the
typed facet. Borrow `/insights`' facet definitions as the rubric.

### 3. `synthesizeInsights()` — same file or `insightsSynthesis.ts`
Second pass: facets + scorecard counts → the report sections. Reuse the
`recommendWorkflow` agent pattern; output a `InsightsReport` interface mirroring
`/insights`' top-level keys, **but** replace `suggestions.features_to_try` with:

```ts
publish_candidates: { sessionId: string; why: string; outcome: SessionOutcome;
                      rerun_hint: boolean; }[];   // → feeds Curate/publish
```

### 4. `streamInsights()` — `src/insightsStream.ts`
Copy `workflowStream.ts:27` structure: `scanWorkflow(..., {retainSequences:true})`
→ `judgeSessions({onDelta})` → `synthesizeInsights` → `send("done", report)`.
Register `GET /api/insights/stream` next to the other SSE routes in `gem.controller.ts`.

### 5. Insights panel — `packages/console/src/panels/Insights/`
Copy `Observe` shell + `scorecardStream.ts` SSE client. Render report sections;
make each `publish_candidate` a button into the existing publish flow. Register in
`pages.tsx` with `group:"observe"`, an `order` below Observe.

## The AgentGem twist (don't just clone)

`/insights` ends at "tweak your CLAUDE.md." Ours ends at **"publish your goldmine."**
The `outcome` enum is the new lever: it lets us compute per-Gem/per-model **success
rates** the attestation currently can't (it has no `outcome` field) — directly feeding
the cross-model-benchmark thesis in `agentgem-biz/strategy/data-sharing-and-telemetry.md`.
Ring 0 (this report) is local/private; Ring 2 reuses the same facet for the network moat.

## Build sequence

1. `facetTypes.ts` + `deterministicFacets` + `validateFacets` (no agent) + unit tests.
2. `judgeSessions` (agent path) reusing `defaultConnectFn`; test degraded fallback.
3. `synthesizeInsights` + `InsightsReport` type; test deterministic synthesis.
4. `streamInsights` + route; wire SSE.
5. Insights panel; register in `pages.tsx`.
6. Publish-candidate → Curate bridge.
7. `npm run build` + console vitest (CI skips console — run locally).

## Open decisions

- **Batch vs per-session judging.** Per-session = parallel facet files like `/insights`
  (better provenance, more agent calls); batch = one prompt (cheaper). Lean batch first.
- **Caching.** Reuse `analysisCache.ts` keyed by transcript token (facets are stable
  per session).
- **Scope of "outcome".** Add `outcome` to the attestation envelope later (separate PR);
  this proposal keeps it local (Ring 0).
