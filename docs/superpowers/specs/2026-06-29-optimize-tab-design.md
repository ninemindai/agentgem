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

The Observe tab answers *"what happened"* (telemetry). Optimize answers *"what should I
change"* (actionable recommendations).

## Decisions (locked)

| Decision | Choice |
|---|---|
| v1 scope | Both A (prune) and B (discover) together |
| Action model | **Recommend-only** in v1. Exact change shown + copy. One-click apply/undo is a v2 fast-follow. |
| MCP external recs | **Out of scope** — skills.sh is skills-only. MCP appears only in the local prune half. External MCP discovery deferred. |
| Relevance ranking | Hybrid: deterministic topic scan → ACP agent re-rank, reusing the existing analyze/`acpRecommender` pattern. |
| Discover engine | An ACP agent **loaded with the `find-skills` skill** (`vercel-labs/skills`), which drives `npx skills find` + skills.sh leaderboard. No hand-rolled HTTP client. |

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

UI has two sections:

1. **Prune — installed but unused.** Table sorted by estimated context savings
   (biggest first). Each row: artifact name, type (skill / MCP), source, est. context
   tokens (labeled *estimate*), uses-in-range, last-used. Expand shows the **exact change
   to make** (file + key) with a copy button. Recommend-only — no mutation.
2. **Discover — recommended for you.** Loads on demand via a button (token-costing).
   Renders ranked cards: skill name, `source` (owner/repo), `installs` count, relevance
   reason, and `npx skills add owner/repo` install command (copy). Graceful empty/degraded
   states.

## Backend

Two paths, split by cost so the cheap local view is always instant.

### ① `GET /api/optimize` — Prune (cheap, local, no LLM)

Joins two local data sources:

- **Installed:** `introspectAll()` (`src/gem/introspect.ts`) → skills, MCP servers,
  instructions, hooks with name / description / source / content / config.
- **Used:** new module `src/gem/optimizeScan.ts`, `scanArtifactUsage(range, filter)`:
  - Reuses observeScan's transcript file discovery (Claude + Codex local JSONL).
  - Counts, per artifact:
    - **skills:** Skill-tool activations (skill-name occurrences in tool calls).
    - **MCP servers:** tool calls whose name matches `mcp__<server>__*`, grouped by
      `<server>`.
  - Returns `Map<artifactKey, { uses, lastUsedMs, sessions }>`.
  - TTL-cached like `scanSessionsCached` (15s).

**Context-cost estimate** (per installed artifact, the part loaded into *every* session):

- skill → `name + description` token estimate.
- MCP server → tool schemas + server instructions token estimate (from config/introspect).
- Estimate via cheap `chars / 4` heuristic (no tokenizer dependency). **Surfaced in the UI
  as an estimate**, not an exact count.

**Pruning candidate** = installed ∧ contextTokens > 0 ∧ `uses === 0` over the range.
Sorted by contextTokens desc (largest savings first). Each candidate carries a
**reversible** deactivation hint (no folder deletion — disable in place so the user can
re-enable later), mapped by the artifact's source:

| Artifact (source) | Reversible disable | File |
|---|---|---|
| Standalone skill (`~/.claude/skills/<name>`, `~/.agents`, `~/.hermes`) | `skillOverrides["<name>"] = "off"` | `settings.json` |
| Plugin skill / MCP / hook (`source = plugin:<key>`) | `enabledPlugins["<key>"] = false` (or `/plugin disable`) | `settings.json` |
| User MCP (`settings.json → mcpServers.<name>`) | remove key, or add to `deniedMcpServers` blocklist | `settings.json` / `~/.claude.json` |
| Codex skill (`~/.codex/skills/<name>`) | move/remove folder (no override flag) | filesystem |
| Codex MCP | `enabled = false` | `~/.codex/config.toml` |

Plugin-provided artifacts collapse to a single `enabledPlugins` toggle — so an unused
plugin is reported once (its biggest-saving artifact), not per child, to avoid telling the
user to disable the same plugin five times.

**Response shape** (Zod in `packages/console/src/api/routes.ts`, mirrored in backend):

```ts
type OptimizePayload = {
  range: "today" | "7d" | "30d" | "all";
  artifacts: Array<{
    name: string;
    type: "skill" | "mcp";
    source?: string;
    contextTokens: number;     // estimate
    uses: number;              // in range
    lastUsedMs?: number;
    prune: boolean;            // candidate flag
    change?: { file: string; key: string };  // exact deactivation target
  }>;
  facets: { agents: string[]; projects: string[] };
};
```

### ② `POST /api/optimize/discover` — Discover (token-costing, opt-in)

Mirrors the existing `analyze` endpoint's "deterministic scan + ACP agent" pattern.

1. **Topic extraction** (deterministic): derive workflow topics from recent sessions /
   projects via `workflowScan` (reuse existing).
2. **ACP agent + `find-skills` skill:** run an ACP agent (reusing `acpRecommender`
   plumbing for structured output) loaded with the `find-skills` skill. Input prompt =
   workflow topics + the already-installed skills list (from `introspectAll`) to exclude.
3. The agent runs `npx skills find …`, applies find-skills' own ranking (install count +
   source reputation + GitHub stars), and returns structured candidates.

**Response shape:**

```ts
type DiscoverPayload = {
  candidates: Array<{
    name: string;
    source: string;       // owner/repo
    installs?: number;
    reason: string;       // relevance to the user's workflows
    installCmd: string;   // npx skills add owner/repo
  }>;
  degraded?: { reason: string };  // e.g. npx skills unavailable / offline
};
```

Controller methods land in `src/gem.controller.ts` next to the existing `observe` /
`analyze` handlers.

## Out of scope (fast-follows)

- **v2 apply/undo:** one-click Disable (prune) / Install (discover) behind explicit confirm
  + undo, via guarded config-write endpoints.
- **External MCP discovery:** a second trusted MCP registry source (no skills.sh equivalent).

## Testing (TDD)

Write tests first, per project + global rules. vitest runs from compiled `dist/`
(clean `dist/` after renames/moves).

- `optimizeScan`: usage counting from fixture transcripts — skill activations and
  `mcp__server__*` grouping; range filtering; last-used.
- context-cost estimate: deterministic for known input.
- prune candidate selection: installed × usage join, threshold, sort order, change-hint
  mapping per type.
- discover: ACP agent invocation mocked; structured-output parsing; **exclude-installed**
  logic; degraded path when `npx skills` is unavailable.
- routes: Zod schema round-trips for both payloads.

## Risks / verify during implementation

1. **skills.sh / `npx skills` reachability:** Discover needs the `npx skills` CLI + network
   at run time. If absent/offline, Discover returns `degraded` with a clear message; Prune
   is unaffected.
2. **MCP usage detection** relies on the `mcp__<server>__*` tool-naming convention appearing
   in transcripts — confirm against real fixtures.
3. **Context-cost is an estimate** (`chars/4`) — must be labeled as such in the UI to avoid
   implying precision we don't have.
4. **Disable-key names are docs-research-sourced**, not yet verified against code. Before
   the UI tells a user to type `skillOverrides` / `enabledPlugins` / `deniedMcpServers`,
   confirm each key against the live Claude Code settings schema (and `~/.codex/config.toml`
   for Codex). If a key turns out not to exist, fall back to "remove from `<file>`".

## Concurrency note

Built in the dedicated worktree `../agentgem-optimize` (`feat/optimize-tab`, off
`origin/main`) — this repo runs concurrent sessions on one checkout.
