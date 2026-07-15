# Agent/model defaults for background agent tasks (issue #430)

**Status:** approved for implementation
**Issue:** https://github.com/ninemindai/agentgem/issues/430

## Problem

Every agent-driven background feature — rubric report render, distill, the workflow
recommender, session judge/lessons (plus dashboard render, insights narration,
discover rerank, session lessons) — spawns a local coding agent over ACP and inherits
the user's default Claude Code model. When that default is a large, slow-generation
model, long-output tasks time out. Timings from the issue: a ~1500-word HTML report
took 68.7s on the heavy default (~180 chars/s) vs ~2.3× faster on Haiku 4.5
(~410 chars/s). These are formatting/summarization tasks, not deep-reasoning tasks.

Verified during design: `claude-agent-acp` treats `process.env.ANTHROPIC_MODEL` as its
**highest-priority** model preference (`acp-agent.js` `getAvailableModels`, priority
1 = `ANTHROPIC_MODEL`, 2 = settings.model, 3 = default), and its
`resolveModelPreference` accepts exact IDs, display names, and alias substrings — so
`claude-haiku-4-5` resolves cleanly. `spawnEnv` (packages/base/src/acpSession.ts)
already overlays `descriptor.env` onto the sanitized base env, so the override needs
no new plumbing at the spawn layer.

## Approaches considered

**A. Descriptor-env overlay resolved inside the insight modules (chosen).**
A persisted per-task-family pref (`~/.agentgem/agent-tasks.json`) read by a
`taskAgent(family)` helper in `packages/base`. Each insight module replaces its
literal `CLAUDE_AGENT` argument with `taskAgent("<family>")`; the descriptor flows
through the existing `connectFn(descriptor, …)` seam unchanged. Minimal diff, no
signature changes, no controller threading; the fake `connectFn` test seam receives
the descriptor, so behavior is directly assertable.

**B. Thread descriptor/model through the controllers into each `opts`.**
More explicit and enables per-request overrides, but touches
`insights.controller`, `rubric.controller`, `dream.controller`, `distillCore`,
`insightsCore`, and duplicates defaulting logic at each call site. The per-run
picker (issue proposal §3) is a nice-to-have deferred anyway — rejected for now;
approach A leaves this open (a later `opts.descriptor` can still bypass prefs).

**C. Mutate the server process env (`process.env.ANTHROPIC_MODEL`) around spawns.**
Rejected: races between concurrent tasks and leaks the override into the
interactive Chat/Studio agent sessions.

## Design (approach A)

### 1. Task families and prefs — `packages/base/src/agentTasks.ts` (new)

```ts
export type AgentTaskFamily = "report" | "distill" | "recommend" | "judge";
export interface AgentTaskPref { agent?: string; model?: string }
export type AgentTaskPrefs = Partial<Record<AgentTaskFamily, AgentTaskPref>>;
export const FAST_MODEL = "claude-haiku-4-5";
export const INHERIT_MODEL = "default";   // sentinel: no override — inherit the interactive default
```

- Family → modules:
  - `report`: reportRender, dashboardRender, narrateInsights
  - `distill`: distill
  - `recommend`: acpRecommender (recommendWorkflow), discoverRerank
  - `judge`: judgeSession, criterionJudge, sessionLessons
- Persistence: `~/.agentgem/agent-tasks.json` (shape = `AgentTaskPrefs`), mirroring
  `packages/memory/src/config.ts`: `loadAgentTaskPrefs(base = agentgemHome())`,
  `saveAgentTaskPref(family, pref, base?)`, JSON `null, 2`, mode `0o600`,
  best-effort (corrupt/missing file → `{}`), never throws.
- Resolution: `taskAgent(family, prefs = loadAgentTaskPrefs())` → `AgentDescriptor`:
  1. Base descriptor: `AGENTS` entry matching `pref.agent`, else `claude-code`.
  2. Model: `pref.model ?? FAST_MODEL`. If the resolved model is `INHERIT_MODEL`
     ("default") **or** the agent is not `claude-code`, no env overlay (codex-acp
     has no verified model env; documented limitation, model select disabled in UI).
  3. Otherwise overlay `env: { ANTHROPIC_MODEL: <model> }` on the descriptor.
- Defaults (no file present): every family → Claude Code + `FAST_MODEL`. This is the
  issue's acceptance criterion ("utility agent tasks default to a fast model");
  the quality-bar open question is resolved as: Haiku by default (measured adequate
  for the report path; recommender/judge outputs are re-validated/heuristic-backed),
  per-family override to Sonnet or the interactive default available in Settings.

### 2. `resolveLaunch` env-merge fix — `packages/base/src/adapters.ts`

Today the desktop (managed/bundled) branch **replaces** `descriptor.env` with
`{ ELECTRON_RUN_AS_NODE: "1" }`, which would drop the `ANTHROPIC_MODEL` overlay.
Change to merge: `{ ...descriptor.env, ELECTRON_RUN_AS_NODE: "1" }`, and preserve
`descriptor.env` on the non-desktop managed path. (`spawnEnv` already re-strips
credential vars after overlay, so this cannot reintroduce a key. The PATH-source
branch already preserves env via `{ ...descriptor }`.)

### 3. Call-site changes — `packages/insight/src/*.ts` (9 modules)

Replace the literal `CLAUDE_AGENT` argument in each module's
`connectFn(CLAUDE_AGENT, null)` with `taskAgent("<family>")`. `CLAUDE_AGENT` stays
exported (tests, fallback identity). No signature changes; `connectFn` fakes in
tests receive the resolved descriptor and can assert `env.ANTHROPIC_MODEL`.

### 4. Settings API — `src/agentTasks.controller.ts` (new, decorator style)

Mirrors `BenchmarkProxyController`:

- `@api({ basePath: "/api/agent-tasks" })`
- `@get("/settings", { response })` → `{ families: { report: {agent, model}, … } }`
  (fully resolved: defaults merged in, so the console renders actual effective values).
- `@post("/settings", { body, response })` — body
  `{ family: enum, agent: string, model: string }` updates one family
  (per-row onChange in the UI), returns the updated full map.
- Registered in `src/index.ts` and `src/client.ts` beside `BenchmarkProxyController`
  (background tasks run locally in both server and client/desktop modes).

### 5. Console Settings section — `packages/console/src/panels/Settings/index.tsx`

New fourth `<section className="ledger-group">` “Background agent tasks”:

- One `ledger-bar` row per family (labels: “Report rendering”, “Skill distillation”,
  “Workflow recommendations”, “Session judging”), each with:
  - agent `<select className="targets-select">` fed from `GET /api/agents`
    (availability-aware: unavailable agents disabled),
  - model `<select className="targets-select">` with options
    `Fast — Haiku 4.5` (`claude-haiku-4-5`), `Balanced — Sonnet` (`claude-sonnet-5`),
    `Interactive default` (`default`); disabled with a `ws-note` when agent ≠ Claude Code.
- Round-trips through the server on change (Contribute.tsx pattern), error → `ledger-error`.
- Typed routes in `packages/console/src/api/routes.ts`
  (`agentTaskSettingsRoute` / `setAgentTaskSettingRoute` + Zod schemas).
- No new CSS classes — reuses `ledger-group/ledger-bar/targets-select/ws-note/ledger-error`.
  (If the model select must show a nonstandard stored value — hand-edited JSON — render
  it as an extra `<option>` so the select reflects reality.)

### 6. Security

The `AGENT_CREDENTIAL_VARS` strip is untouched; `spawnEnv` re-strips after every
overlay. The new overlay only ever adds `ANTHROPIC_MODEL`. A test asserts a
malicious pref (`model` set, plus hypothetical env injection) cannot reintroduce
stripped credentials.

## Error handling

- Prefs file unreadable/corrupt → defaults (fast model). Never blocks a task.
- Unknown `agent` id in prefs → fall back to `claude-code` descriptor.
- POST with unknown family → 422 via Zod enum.
- All agent tasks keep their existing degrade-never-throw semantics.

## Testing

- `packages/base/src/__tests__/agentTasks.test.ts`: defaults; load/save round-trip in
  a temp dir; corrupt file → defaults; `taskAgent` env overlay for fast/sonnet;
  `INHERIT_MODEL` → no env; codex → no env; unknown agent → claude-code.
- `adapters` test: `resolveLaunch` preserves `descriptor.env` and merges
  `ELECTRON_RUN_AS_NODE` on desktop managed/bundled source.
- `acpSession.env.test.ts` addition: `ANTHROPIC_MODEL` overlay survives `spawnEnv`;
  credential vars still stripped alongside it.
- One insight call-site test (reportRender): fake `connectFn` asserts the received
  descriptor carries `env.ANTHROPIC_MODEL === FAST_MODEL` by default and the
  prefs-selected model when a temp prefs file says otherwise.
- Controller: GET/POST round-trip test following the benchmark controller tests.
- CI note: `packages/console` vitest is NOT in CI — run console tests + typecheck
  locally; verify styled UI in a real browser.

## Out of scope (follow-ups)

- In-context per-run picker on report/distill actions (issue proposal §3).
- Codex model selection (needs a codex-acp mechanism; UI shows the limitation).
- Free-text custom model entry in the UI (the JSON file accepts any string today).
