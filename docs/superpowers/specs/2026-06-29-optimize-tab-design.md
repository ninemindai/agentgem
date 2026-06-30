# Optimize tab — design

**Status:** approved design, pre-implementation
**Date:** 2026-06-29
**Branch:** `feat/optimize-tab` (worktree `../agentgem-optimize`, off `origin/main`)

## Goal

Add an **Optimize** tab as the second panel in the existing **Observe** group of the
React console. It helps a user tune their local agent setup along two axes:

- **Prune (A):** discover what's installed (skills + MCP servers) vs. what actually
  fires in real sessions, and recommend deactivating installed-but-unused artifacts
  that burn context/token budget on every session.
- **Discover (B):** recommend *new* skills, ranked by relevance to the user's actual
  workflows, sourced from a trusted registry (skills.sh via the `find-skills` skill).
- **Instructions health (C):** CLAUDE.md / AGENTS.md and similar instructions load into
  **every** session, so they can't be "unused" — their lever is *weight*. Surface each
  instructions artifact's context-token cost and deterministic bloat flags so the user can
  trim what silently taxes every session.

The Observe tab answers *"what happened"* (telemetry). Optimize answers *"what should I
change"* (actionable recommendations).

## Decisions (locked)

| Decision | Choice |
|---|---|
| v1 scope | Both A (prune) and B (discover) together |
| Action model | **Recommend-only** in v1. Exact change shown + copy. One-click apply/undo is a v2 fast-follow. |
| MCP external recs | **Out of scope** — skills.sh is skills-only. MCP appears only in the local prune half. External MCP discovery deferred. |
| Relevance ranking | Hybrid: deterministic topic scan + registry fetch (default, free) → optional ACP agent re-rank, reusing the existing analyze/`acpRecommender` pattern. |
| Discover engine | **Direct registry fetch (Stage 1) + optional ACP re-rank (Stage 2).** *Amended 2026-06-29* — the original "ACP-only, via the `find-skills` skill / `npx skills find`" decision is superseded. The `skills.sh` *documented* API (`/api/v1/*`) is OIDC-auth-walled, but the **undocumented, unauthenticated** `GET https://skills.sh/api/search?q=&limit=&owner=` endpoint (the one the `skills` CLI itself calls) returns clean JSON. Stage 1 fetches it directly via an isolated `skillsRegistry` client (no `npx` subprocess, no LLM); Stage 2 is an opt-in ACP re-rank that degrades to Stage-1 order. |
| Instructions health depth | **Deterministic now** (weight + bloat flags, local, in Plan 1). LLM-driven semantic critique (redundant/stale/contradictory rules, rewrite suggestions) is deferred to a later ACP plan. |

## Plan decomposition

Three independent, separately-shippable plans (this spec covers all three; Plan 1 is
written first and is fully shippable on its own):

- **Plan 1 — Optimize panel + local analysis (no LLM, no tools).** Panel shell + Prune
  (skills/MCP usage) + Instructions health (weight/bloat). Endpoint `GET /api/optimize`.
- **Plan 2 — Discover (registry fetch + optional ACP re-rank).** Endpoints
  `GET /api/optimize/discover` (deterministic) + `POST /api/optimize/discover/rerank` (ACP).
- **Plan 3 — Semantic instructions critique (ACP).** LLM reads CLAUDE.md → flags
  redundant/stale/contradictory rules + rewrite suggestions.

## Placement & frontend

New panel `packages/console/src/panels/Optimize/`:

- `index.tsx` exports `optimizePage` via
  `defineConsolePage({ id: "optimize", title: "Optimize", icon: "⚡", order: 2, group: "observe", route: "#/optimize", component: Optimize })`.
- Registered by adding `optimizePage` to the `pages` array in
  `packages/console/src/pages.tsx`.
- This makes it the **second tab in the existing `observe` group** — no nav/shell/routing
  changes needed (the registry seam in `registry.ts` / `Shell.tsx` groups automatically).
- Reuses the shared `ObserveFilter` (agent / project / range) and `fmtTokens` from the
  Observe panel's `data.ts`.

UI has three sections:

1. **Prune — installed but unused.** Table sorted by estimated context savings
   (biggest first). Each row: artifact name, type (skill / MCP), source, est. context
   tokens (labeled *estimate*), uses, last-used. Expand shows the **exact change
   to make** (file + key) with a copy button. Recommend-only — no mutation.
2. **Instructions health.** Table of every **global** instructions artifact (user
   CLAUDE.md / AGENTS.md / codex rules / hermes). Each row: name/source, est. context tokens
   loaded **every session** (labeled *estimate*), line count, and deterministic bloat flags
   (`oversized`, `very-long`, `duplicate-lines`). Sorted by context tokens desc. Plan 1.
   *(v1 is global-only — `introspectConfig()` returns no project inventories; per-project
   CLAUDE.md is a fast-follow.)*
3. **Discover — recommended for you.** *(Plan 2)* A **"Find recommendations"** button runs
   Stage 1 on demand (free — a network call, so not auto-run). Renders ranked rows: skill
   name, `source` (owner/repo), `installs` (labeled *registry-reported*), relevance reason,
   `npx skills add owner/repo@name` install command (copy), and a link to skills.sh. Once
   results exist, a secondary **"Re-rank with AI"** button runs Stage 2 (token-costing,
   labeled). Recommend-only — no install is performed. Graceful empty/degraded states.

## Backend

Two paths, split by cost so the cheap local view is always instant.

### ① `GET /api/optimize` — Prune (cheap, local, no LLM)

Joins two local data sources:

- **Installed:** `introspectConfig()` (`src/gem/introspect.ts`) → `ConfigInventory`
  (`skills`, `mcpServers`, `instructions`, `hooks`) with name / description / source /
  content / config.
- **Used:** new module `src/gem/optimizeScan.ts`, `scanArtifactUsage(opts)`:
  - **Reuses the existing `scanWorkflow()`** (`src/gem/workflowScan.ts`) rather than
    re-parsing transcripts — it already detects `Skill(...)` activations and
    `mcp__<server>__*` tool calls (`workflowScan.ts:300-373`) and resolves them against an
    inventory, producing `ArtifactUsage[]` with `invocations`, `sessionsUsedIn`,
    `lastUsedMs`.
  - Calls `scanWorkflow(allClaudeTranscripts(claudeDir), { project: <installed inventory
    as a synthetic project>, global: { skills: [], mcpServers: [], hooks: [] } })` once
    over **all** Claude transcripts. The installed inventory is passed as the `project`
    inventory (not `global`) because scanWorkflow emits **every project artifact including
    unused ones** (`invocations: 0`), whereas it drops unused *global* artifacts —
    and unused is exactly what we need.
  - Returns `Map<artifactKey, ArtifactUsage>` keyed by `type + ":" + name`.
  - TTL-cached (15s) like `scanSessionsCached`.
  - **v1 scope:** Claude transcripts only (Codex tool-call parsing is a follow-up — Codex
    skills/MCP are reported with `uses: 0` and a "usage not tracked for Codex yet" note
    rather than being mis-flagged as unused).

**Context-cost estimate** (per installed artifact, the part loaded into *every* session):

- skill → `name + description` token estimate.
- MCP server → tool schemas + server instructions token estimate (from config/introspect).
- Estimate via cheap `chars / 4` heuristic (no tokenizer dependency). **Surfaced in the UI
  as an estimate**, not an exact count.

**Pruning candidate** = installed ∧ not used within the selected
range — i.e. `lastUsedMs == null` (never used) **or** `lastUsedMs < rangeStart`. (We derive
this from all-time `lastUsedMs` rather than a per-range re-scan; the UI shows total `uses`
+ `lastUsed`, not an in-range count, to stay honest about what the cheap scan supports.)
Sorted by contextTokens desc (largest savings first). Each candidate carries a
deactivation hint, mapped by the artifact's source. **Verified against the live Claude Code
settings docs during Task-6 e2e (risk #4): the earlier docs-research key `skillOverrides`
does NOT exist, and `deniedMcpServers` is managed-settings-only — both were removed.**

| Artifact (source) | Disable hint | File |
|---|---|---|
| Plugin skill / MCP / hook (`source = plugin:<key>`) | `enabledPlugins["<key>"] = false` (or `/plugin disable`) — **verified real** (read by `introspect.ts`, present in real settings) | `settings.json` |
| Standalone / agent / hermes / codex skill | **no in-place disable flag exists** → remove or move the skill folder | `~/.claude/skills/<name>` (·`~/.agents`·`~/.hermes`·`~/.codex` per source) |
| User MCP (`mcpServers.<name>`) | remove the entry; or `disabledMcpjsonServers: ["<name>"]` if the server is defined via `.mcp.json` | `settings.json` / `~/.claude.json` |
| Codex MCP | `enabled = false` | `~/.codex/config.toml` |

Plugin-provided artifacts collapse to a single `enabledPlugins` toggle — so an unused
plugin is reported once (its biggest-saving artifact), not per child, to avoid telling the
user to disable the same plugin five times. Skills have no settings toggle, so their hint is
honestly "remove the folder" rather than a fake in-place key.

**Response shape** (Zod in `packages/console/src/api/routes.ts`, mirrored in backend):

```ts
type OptimizePayload = {
  range: "today" | "7d" | "30d" | "all";
  artifacts: Array<{
    name: string;
    type: "skill" | "mcp";
    source: string;
    contextTokens: number;     // estimate (chars/4)
    uses: number;              // all-time invocations
    lastUsedMs: number | null;
    prune: boolean;            // candidate flag (see rule above)
    change: { file: string; key: string };  // exact reversible deactivation target
  }>;
  instructions: Array<{
    name: string;
    source: string;            // "user" | project root | import source
    contextTokens: number;     // estimate, loaded EVERY session
    lines: number;
    flags: Array<"oversized" | "very-long" | "duplicate-lines">;
  }>;
  facets: { agents: string[]; projects: string[] };
};
```

**Instructions health (C)** — deterministic, derived from `ConfigInventory.instructions`
(**global only** in v1; `introspectConfig()` returns no `projects`, so per-project
instructions are a fast-follow that enriches the handler's inventory):

- `contextTokens` = `chars/4` of `content` (same estimator as skills/MCP).
- `lines` = non-empty line count.
- Flags (tunable constants): `oversized` if `contextTokens > 2000`; `very-long` if
  `lines > 300`; `duplicate-lines` if ≥ 5 identical non-blank trimmed lines repeat.
- No usage join — instructions always load, so there is nothing to "prune"; the section is
  pure weight/health. Sorted by `contextTokens` desc.

### ② Discover — two-stage (registry fetch + optional ACP re-rank)

Hybrid. **Stage 1 is the default and is free** (no LLM, no subprocess); **Stage 2 is
opt-in and token-costing**. Prune / Instructions health are unaffected by either.

#### Registry client (isolated, degrades gracefully)

A small `skillsRegistry` module — one search function — wraps the **undocumented,
unauthenticated** skills.sh search endpoint that the `skills` CLI itself uses:

```
GET https://skills.sh/api/search?q=<query>&limit=<n>[&owner=<owner>]
→ 200 { skills: [{ id, skillId, name, installs, source }], searchType, count }
```

- Plain `fetch`, **no auth header**. (The *documented* `/api/v1/*` API is OIDC-walled and is
  deliberately NOT used.)
- Because the endpoint is undocumented it may change without notice — per
  [[local-control-plane]] "no hard dependency on an API you don't control": **any non-200,
  network error, or parse failure resolves to `[]`/degraded**, never throws. Isolating it in
  one module keeps the swap-or-add-registry path open (the "aggregator above registries"
  thesis) without touching the panel.

#### `GET /api/optimize/discover` — Stage 1 (deterministic, free, on-demand)

1. **Topic extraction** (deterministic): derive the top ~3–5 workflow topics from recent
   sessions via `workflowScan` (reuse existing; same scan Prune uses).
2. **Registry search:** `skillsRegistry.search(topic)` per topic.
3. **Exclude already-installed** skills (match on `source`/`name` against the inventory from
   `introspectAll`/`introspectConfig`).
4. **Dedupe** across topics; **rank** by `(topic-match strength, installs)`; cap at ~8–10.
   Deterministic `reason` per item (e.g. *"matches your `react` + `testing` sessions"*).
   `installs` is **registry-reported** (labeled as such in the UI — not an AgentGem
   endorsement, per the security-signal-liability caution in [[local-control-plane]]).
5. Result cached with a short TTL (registry data moves slowly; ~5 min, `scanArtifactUsageCached`
   style) so repeat opens are cheap.

#### `POST /api/optimize/discover/rerank` — Stage 2 (ACP, token-costing, opt-in)

Body = Stage-1 `candidates` + `topics`. Reuses `acpRecommender` plumbing (plan-mode,
permissions denied, structured-output validation). The agent reorders by semantic relevance
and rewrites each `reason`; validation **drops any candidate not in the input set** (no
hallucinated skills). **Degrades to the Stage-1 order** (`reranked: false` + `degraded`) on
any ACP failure — the existing `deterministicAnalysis` fallback pattern.

**Response shape (both endpoints):**

```ts
type DiscoverCandidate = {
  name: string;          // skill name
  source: string;        // "owner/repo"
  registry: "skills.sh"; // future-proof for the aggregator thesis
  installs?: number;     // registry-reported
  url: string;           // https://skills.sh/<id>
  reason: string;        // topic match (Stage 1) or AI rationale (Stage 2)
  installCmd: string;    // "npx skills add owner/repo@name"
};
type DiscoverPayload = {
  candidates: DiscoverCandidate[];
  topics: string[];               // what we matched on (shown to user)
  reranked?: boolean;             // true after Stage 2
  degraded?: { reason: string };  // registry offline / ACP failed
};
```

Controller methods land in `src/gem.controller.ts` next to the existing `observe` /
`analyze` / `optimize` handlers; both typed via `defineRoute` in
`packages/console/src/api/routes.ts`.

## Out of scope (fast-follows)

- **v2 apply/undo:** one-click Disable (prune) / Install (discover) behind explicit confirm
  + undo, via guarded config-write endpoints.
- **External MCP discovery:** a second trusted MCP registry source (no skills.sh equivalent).
- **Semantic instructions critique (Plan 3):** LLM reads CLAUDE.md → flags redundant / stale
  / contradictory rules and proposes rewrites. ACP/token-costing, separate plan.
- **Codex usage parsing:** v1 counts Claude tool-calls only; Codex artifacts show
  `uses: 0` with an explicit "not tracked yet" note (never auto-flagged as prunable).
- **Per-project instructions health:** v1 is global-only (`introspectConfig()` has no
  `projects`). Fast-follow: enrich the handler's inventory with `introspectProject(root)`
  for relevant roots (e.g. from recent sessions) so per-project CLAUDE.md/AGENTS.md render.

## Testing (TDD)

Write tests first, per project + global rules. vitest runs from compiled `dist/`
(clean `dist/` after renames/moves).

- `optimizeScan`: usage counting from fixture transcripts — skill activations and
  `mcp__server__*` grouping; `lastUsedMs`; map keying by `type:name`.
- context-cost estimate: deterministic for known input.
- prune candidate selection: installed × usage join, range rule (`lastUsedMs` vs
  `rangeStart`), sort order, change-hint mapping per source type, plugin de-duplication.
- instructions health: token estimate, line count, each bloat flag (`oversized`,
  `very-long`, `duplicate-lines`) at/around its threshold.
- routes: Zod schema round-trip for `OptimizePayload`.
- (Plan 2) `skillsRegistry.search`: mock `fetch` — parse, sort by installs, owner filter,
  non-200 → `[]`, parse-error → `[]`.
- (Plan 2) discover Stage 1: topic derivation, exclude-installed join, dedupe, ranking, cap,
  reason text; degraded when the registry returns nothing.
- (Plan 2) rerank Stage 2: ACP agent mocked — reorder, **drop out-of-set** items,
  degrade-to-input order on failure.
- (Plan 2) routes: Zod round-trip for `DiscoverPayload`.

## Risks / verify during implementation

1. **skills.sh reachability + endpoint stability:** Stage 1 needs network at run time and
   depends on the **undocumented** `GET /api/search` endpoint, which can change without
   notice. On any non-200 / network / parse failure the `skillsRegistry` client returns
   `[]` and Discover returns `degraded` with a clear message; Prune is unaffected. Verify the
   live response shape (`{ skills: [{ id, name, installs, source }] }`) during implementation.
2. **MCP usage detection** relies on the `mcp__<server>__*` tool-naming convention appearing
   in transcripts — confirm against real fixtures.
3. **Context-cost is an estimate** (`chars/4`) — must be labeled as such in the UI to avoid
   implying precision we don't have.
4. **Disable-key names — RESOLVED in Task 6.** Verified against the live Claude Code settings
   docs: `enabledPlugins` is real; `skillOverrides` does **not** exist and `deniedMcpServers`
   is managed-settings-only — both removed. Hints now: plugins → `enabledPlugins`; skills →
   "remove the folder" (no toggle exists); user MCP → remove entry or `disabledMcpjsonServers`
   (for `.mcp.json` servers); codex MCP → `config.toml enabled=false`. See the hint table above.

## Integration with the built-in `/insights` command

Claude Code's built-in `/insights` analyzes local session transcripts and writes structured
data to `~/.claude/usage-data/`:

- `session-meta/<session>.json` — quantitative, deterministic, **census** over all recent
  sessions (parsed locally, no model): `tool_counts`, `tool_errors`,
  `tool_error_categories`, `uses_mcp`, `lines_added/removed`, `files_modified`,
  `git_commits/pushes`, `user_response_times`, `languages`, `input/output_tokens`.
- `facets/<session>.json` — **LLM-judged on a small SAMPLE** of sessions (e.g. 35 of
  1,432), not a census: `underlying_goal`, `goal_categories` (e.g. debugging /
  architecture_planning / documentation), `outcome`, `friction_counts`, `friction_detail`,
  `claude_helpfulness`, `brief_summary`. Treat as sampled inference, not fact.
- `report-*.html` — the rendered dashboard. Section titles: *Top Tools Used*, *Suggested
  CLAUDE.md Additions*, *Existing CC Features to Try*, *New Ways to Use Claude Code*,
  *Where Things Go Wrong* (friction/errors).

These sections map almost 1:1 onto this design, so we **borrow** rather than duplicate:

- **Validates Plan 1.** `tool_counts` records MCP servers by full name but skills only as a
  generic `Skill` bucket (no per-skill breakdown). So `/insights` data **cannot** replace
  our per-skill prune scan — it confirms `scanWorkflow` (which reads `input.skill`) is the
  right engine for skill-level usage.
- **Enriches Plan 2 (Discover).** `workflowScan` (every transcript) stays the **primary**
  topic signal. When `facets/*.json` is present, use its `goal_categories` /
  `underlying_goal` as *qualitative enrichment over the sampled sessions only* — it is a
  ~2% LLM sample, not a census, so it can sharpen but must not drive relevance ranking.
  Graceful fallback to `workflowScan` when absent. Optional enrichment, never a dependency —
  a timestamped snapshot that only exists if the user ran `/insights`.
- **Aligns Plan 3.** Anthropic's report already frames CLAUDE.md tuning as a first-class
  output ("Suggested CLAUDE.md Additions"). Plan 3's ACP critique should emit the same
  shape of add/trim/fix suggestion; cite this as prior-art validation.
- **Positioning.** `/insights` is the *qualitative* report (goals, satisfaction, friction);
  Optimize is the *quantitative + actionable* complement (token cost, prune-this,
  install-that). Do not re-render goals/satisfaction. A future "Friction" optimization
  section could read `friction_counts` to suggest fixes — noted, not built now.

## Concurrency note

Built in the dedicated worktree `../agentgem-optimize` (`feat/optimize-tab`, off
`origin/main`) — this repo runs concurrent sessions on one checkout.
