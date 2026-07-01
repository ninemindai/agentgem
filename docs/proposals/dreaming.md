# Proposal: Dreaming — an autonomous review queue over the background scan/analyze job

Status: proposed · Author: derived from an OpenClaw teardown + a scan of the
`warm-precompute` / `insight` seams at `feat/build-nav-gem-scope`

Dreaming turns the work the background job already does into a standing, reviewable
output. Today AgentGem distills skills and lessons only when a user opens Insights or
Analyze and watches a stream. The `feat/warm-precompute` job (PR #55) already recomputes
that analysis in the background — but nobody sees the result until they navigate to the
exact project panel. Dreaming **harvests those already-computed drafts into one review
queue**, keeps a **diary** of what each pass found, and shows a **phase readout** of the
background job's activity. Nothing is installed or published without an explicit accept.

The name and shape are borrowed from OpenClaw's "Dreaming" (memory consolidation that
runs while the agent is idle, with LIGHT/DEEP/REM phases and a count of "promoted"
memories). The engine underneath is entirely AgentGem's own.

## Alignment principle (the load-bearing constraint)

**Dreaming owns no scanner, no scheduler, and no distillation.** It is a *consumer* of
the one canonical background job. Every input already exists:

- **Scanner** — `scanWorkflow(paths, ScanInventory) → WorkflowSignal`
  (`packages/insight/src/workflowScan.ts`) is the single deterministic source of truth.
  Setup comes from `introspectProject()`/`introspectConfig()` (`@agentgem/capture`),
  sessions from `claudeTranscriptsForCwd()`.
- **Scheduler** — `startWarmSchedule()` (`src/warm/schedule.ts`, #55): boot + idle loop,
  re-entrancy guard, foreground gate (`beginForeground`/`endForeground`/
  `isForegroundBusy`), console-only (`SERVE_CONSOLE !== "false"`).
- **Distillation** — the `analyze` warmable calls `computeWorkflowAnalysis(root)`
  (`src/workflowCore.ts`, #55), whose `WorkflowAnalysisPayload` already carries
  `distilled: DistilledSkill[]`, `reflections: Reflection[]`, and `gaps: string[]`,
  cached in `~/.agentgem/analysis-cache.json` keyed by `transcriptToken(paths)`. The
  `insights` warmable does the same for cross-session synthesis via
  `computeInsights(root)` (`src/insightsCore.ts`).

Because the drafts are already computed and cached, **Dreaming adds zero marginal LLM
cost.** It reads caches, diffs against what the user has already reviewed, and enqueues
what is new.

## The phase model — names over existing warmables, not new compute

OpenClaw's sleep phases map one-to-one onto the warmables `runWarmPass()` already runs,
grouped by cost:

| Phase | Warmable(s) | Cost | Produces |
|-------|-------------|------|----------|
| **LIGHT** | `usage`, `scorecard` | cheap / deterministic | breadth + battle-tested + portable counts, usage |
| **DEEP** | `analyze` | per-root LLM | `distilled` skills, `reflections` (lessons), `gaps` |
| **REM** | `insights` | per-root LLM | cross-session facets + narrative |

The Dreaming panel lights a phase when its warmable ran in the last pass (read from
`getWarmStatus()`). No phase is a new subsystem; the labels make the background job's
activity legible — that is the entire borrow.

## What Dreaming adds (the whole surface)

Three thin pieces:

### 1. A harvest step — the `dream` warmable

Registered in `src/warm/registry.ts`, `cost: "cheap"`, `scope: "per-root"`, runs **last**
in a pass so the `analyze`/`insights` caches for the just-warmed roots are fresh. Its
`warm(root)` does no LLM and no re-scan — it reads the analysis (and insights) cache entry
for `root`, maps each fresh draft to a queue item, diffs against the reviewed-set, and
appends anything new plus a diary entry. Because it is deterministic and cheap, it needs
no foreground gate of its own (the LLM cost already happened in `analyze`/`insights`).

Mapping cache → queue:

- `payload.distilled[]` → `kind: "skill"` items
- `payload.reflections[]` → `kind: "lesson"` items (a `Reflection` is a durable
  takeaway: `{ detail, importance }` — the existing "lesson" primitive)
- `payload.gaps[]` → surfaced in the Scene tab as "what's missing," not queued as drafts

### 2. A review-queue + diary store

`src/dream/store.ts`, persisting to `~/.agentgem/.agentgem/dream/queue.json` and
`.../dream/diary.json` (mirrors `reflectionStore.ts`'s sidecar convention; best-effort,
never throws).

```ts
type DreamKind = "skill" | "lesson";
type DreamStatus = "queued" | "accepted" | "dismissed";

interface DreamQueueEntry {
  key: string;            // stable dedup key: `${kind}:${root}:${name}:${provenanceHash}`
  kind: DreamKind;
  root: string;
  name: string;
  summary: string;        // skill.description | reflection.detail
  confidence?: "high" | "medium" | "low";   // skills
  importance?: "high" | "medium";           // lessons
  phase: "DEEP" | "REM";  // which phase surfaced it
  draft: DistilledSkill | Reflection;        // full body, for the Curate handoff
  status: DreamStatus;
  firstSeenMs: number;
  reviewedMs?: number;
}

interface DreamDiaryEntry {
  atMs: number;
  passId: string;                              // ties to a WarmPassResult
  rootsProcessed: string[];
  phasesLit: ("LIGHT" | "DEEP" | "REM")[];
  enqueued: { skills: number; lessons: number };
  degraded: boolean;
}
```

Dedup is by `key` (name + root + a hash of `evidence.provenance`), so a draft the user
accepted or dismissed never resurfaces even as the background job recomputes. Retention is
bounded: keep all `queued`, the last N `accepted`/`dismissed`, and the last ~100 diary
entries.

**"Promoted"** (OpenClaw's counter) = entries with `status: "accepted"`.

### 3. A Dreaming panel

`packages/console/src/panels/Dreaming/index.tsx`, exporting `dreamingPage: ConsolePage`
in group `"observe"` (ordered after Insights). Three tabs:

- **Scene** — a `DREAMING ON/OFF` toggle, the LIGHT/DEEP/REM phase readout (lit from
  `getWarmStatus()`), the promoted count, `gaps`, and a **Dream now** button (force a
  pass). Reuses the existing `WarmingPill` for live status.
- **Queue** — the list of `queued` drafts; each row **Accept** (→ Curate) or **Dismiss**.
- **Diary** — reverse-chronological pass history.

### REST surface

Added as an AgentBack controller (`src/dream.controller.ts`), following the existing
`@api`/`@get`/`@post` controllers:

- `GET  /api/dream/status` → `{ enabled, phasesLit, promoted, queuedCounts, lastPassAtMs }`
- `GET  /api/dream/queue` → `DreamQueueEntry[]` (status `queued`)
- `POST /api/dream/queue/:key/accept` → writes the draft into the existing
  `.agentgem/distilled/…` location (`writeDistilledDraft` for skills,
  `writeDistilledLesson` for lessons) so it enters the **existing Curate review flow**,
  marks the entry `accepted`, returns a deep-link to Curate.
- `POST /api/dream/queue/:key/dismiss` → marks `dismissed`.
- `POST /api/dream/run` → force a pass (`runWarmPass({ force: true })`).

Accepting never installs into a build — it promotes the draft to the Curate stage, which
remains the gate to fold anything into a Gem.

## Safety and defaults

- **Opt-in, off by default** (`AGENTGEM_DREAM_ENABLED`, default false) — OpenClaw ships
  "DREAMING OFF"; an autonomous loop over the user's work should not run until asked. When
  off, the `dream` warmable is not registered and the panel shows a one-click enable.
- **No new data access.** Dreaming reads only caches that the `analyze`/`insights`
  warmables already produced from local transcripts. It introduces no reading of session
  content beyond what #55 already does, makes no network calls, and never auto-publishes.
- **Never auto-lands.** Every draft requires an explicit Accept, then still passes through
  Curate. Dismiss is permanent (via the reviewed-set).
- **Inherits degradation.** Upstream `degraded: true` is recorded on the diary entry and
  shown on the row; Dreaming never throws (best-effort store, like `reflectionStore`).

## Out of scope (YAGNI)

Explicitly **not** in this proposal, to keep it to one queue + one warmable + one panel:

- A persistent cross-session **memory store** (OpenClaw's "promoted memories" model). Our
  chosen output is a review queue; a standing memory artifact is a separate, larger design.
- **Auto-updating Gems** from fresh drafts.
- The richer per-session **`distillSessionLessons`** track — v1 uses the `reflections`
  the `analyze` pass already emits; folding `distillSessionLessons` into
  `computeWorkflowAnalysis` is a future enrichment, not a launch requirement.
- Messaging **channels**, persona **core-files** (SOUL/IDENTITY), and multi-**node**
  presence — other OpenClaw ideas, tracked separately.

## Dependency

This builds directly on **PR #55 (`feat/warm-precompute`)** — its headless cores
(`workflowCore.ts`, `insightsCore.ts`), the `WARMABLES` registry, `startWarmSchedule()`,
`getWarmStatus()`, and the `WarmingPill`. #55 is open and green (1194 backend + 253
console tests). **Sequence: land #55, then build Dreaming on it.** No parallel scanner or
scheduler is introduced.

## To verify during implementation

- Whether the background `analyze` path already persists distilled drafts to
  `.agentgem/distilled/…` (via `writeDistilledDraft`) or only returns them in the cached
  payload. If it already writes them, the queue collapses into a marker+view layer over
  that directory plus the reviewed-set and diary; if not, the queue stores the draft
  bodies as specified above. The `key`-based design works either way.
- The exact shape of `WarmPassResult` needed to derive `phasesLit` and `passId`.

## Testing

The design is deliberately LLM-free on the Dreaming path, so tests need no ACP stubbing:

- **Store** — accept/dismiss transitions, dedup by `key`, bounded retention. Pure, TDD.
- **`dream` warmable** — given a fixture analysis/insights cache with N drafts: enqueues
  new, skips reviewed, writes a correct diary entry, records `degraded`. Deterministic.
- **Controller** — status/queue/accept/dismiss/run, including the Curate handoff write.
- **Panel** — phase readout renders from a mocked `getWarmStatus()`; queue actions call
  the right endpoints. (Console tests are not in CI — run locally.)

## Build sequence

1. `src/dream/store.ts` + types — queue + diary, TDD first.
2. `dream` warmable — harvest from warm caches into the store (behind
   `AGENTGEM_DREAM_ENABLED`).
3. `src/dream.controller.ts` — the five endpoints + Curate handoff.
4. `packages/console/src/panels/Dreaming/` — Scene / Queue / Diary, reusing `WarmingPill`.
5. Register the panel in `pages.tsx`; gate the warmable on the enable flag.
