# Optimize ▸ Prune — reversible Disable / Re-enable

**Date:** 2026-06-30
**Status:** Approved design, pending implementation plan
**Extends:** `2026-06-29-optimize-tab-design.md` (the recommend-only Prune table)

## Problem

The Optimize tab's **Prune** section lists installed-but-unused skills and MCP
servers and, per row, shows a read-only `to disable` hint (the exact config
change a user would make by hand). It is deliberately *recommend-only* —
"nothing is changed for you" (`Dashboard.tsx`). Users have asked for a button to
actually disable/uninstall an unused skill instead of copying a hint and editing
files themselves.

## Goals

- Let the user **select multiple prune rows** and disable them in one action.
- Every disable is **reversible** — no destructive deletes. A **Disabled**
  section lists what was disabled, each with a **Re-enable** action that reverses
  it exactly.
- Behave **consistently across coding agents** — Claude, Agents, Codex, Hermes —
  reusing `introspect.ts`'s source→root mapping so the write path never drifts
  from the read path.

## Non-goals

- No irreversible uninstall / folder deletion. (Relocation only.)
- No project-scoped or distilled-draft artifacts (they aren't globally loaded).
- No global Codex/Hermes **MCP** disable — the global inventory doesn't surface
  those today (only project scope reads `~/.codex/config.toml`). Codex/Hermes
  parity is delivered through the shared **skills** path.

## Key finding that shapes the mechanism

Moving a standalone skill folder is not merely convenient — it is the **only**
way to truly deactivate it. Claude Code (and the other agents' loaders) key off a
skill folder containing `SKILL.md`/`DESCRIPTION.md`; there is no in-place
"disabled" flag they honor, and a frontmatter `internal: true` is an AgentGem
introspection convention, not a runtime one. So a "disabled list" or flag edit
would hide the skill from our panel while the agent kept loading it. Relocating
the folder out of the skills root is correct and necessary.

## Mechanism (per artifact — all reversible)

| Artifact | source | Disable | Re-enable |
|---|---|---|---|
| Plugin (skill or MCP) | `plugin:X` | `enabledPlugins["X"] = false` in `~/.claude/settings.json` | set `true` |
| Standalone skill | `standalone` / `agent` / `codex` / `hermes` | move `<root>/<name>` → `<archive>/skills/<source>/<name>` | move back to `<root>/<name>` |
| MCP via `.mcp.json` | `user` (origin `.mcp.json`) | add `name` to `disabledMcpjsonServers` in `~/.claude/settings.json` | remove from `disabledMcpjsonServers` |
| MCP via `settings.json` | `user` (origin `settings.json`) | stash entry to `<archive>/mcp/<name>.json`, delete from live `mcpServers` | write entry back into `mcpServers`, delete stash |

The archive path **encodes provenance**, so re-enable is deterministic with no
separate manifest file.

### source → live skills root (identical to `introspect.ts`)

| source | live root |
|---|---|
| `standalone` | `~/.claude/skills` |
| `agent` | `~/.agents/skills` |
| `codex` | `~/.codex/skills` |
| `hermes` | `~/.hermes/skills` |

Hermes skills are `DESCRIPTION.md`-bodied; the whole `<name>` folder is moved, so
the body filename is irrelevant. `distilled-draft` and `project` sources are
**excluded** (ineligible — no checkbox).

### MCP origin resolution

The inventory flattens both `settings.json` `mcpServers` and `.mcp.json` to
`source: "user"` (`introspect.ts`). To pick the correct reversible mechanism, the
disable core **re-reads the raw config**: if the name is a key under
`settings.json.mcpServers` → stash-and-remove; else if present in `.mcp.json` →
`disabledMcpjsonServers` flag. If found in neither (already gone) → no-op success.

## Archive layout

Root: `<agentgemHome>/.agentgem/disabled/` — agent-neutral (NOT under a `claude/`
segment, since it holds codex/hermes/agent skills too), and never inside any
agent's config dir, so no runtime re-loads it. Base resolution mirrors
`introspect.ts`: `agentgemHome()` normally, `dirname(claudeDir)` under test dir
overrides.

```
<base>/.agentgem/disabled/
  skills/<source>/<name>/      # relocated skill folder (source ∈ standalone|agent|codex|hermes)
  mcp/<name>.json              # stashed settings.json mcpServers entry: { "name": ..., "config": {...} }
```

Plugin and `.mcp.json` MCP disables need no archive file — their disabled state
lives in `settings.json` flags and is enumerated from there.

## Backend

New module **`packages/capture/src/disableArtifact.ts`** — the write-twin of
`introspect.ts`, co-located with the config authority it mutates. It accepts the
same dir overrides (`claudeDir`/`agentDir`/`codexDir`/`hermesDir`) as
`IntrospectOptions` so it stays in lockstep with the reader and is testable
against a temp home.

Exports:

```ts
export interface DisableItem { type: "skill" | "mcp"; name: string; source: string }
export interface DisableResult { type: "skill" | "mcp"; name: string; ok: boolean; message: string }

export function disableArtifacts(items: DisableItem[], opts?: IntrospectOptions): DisableResult[];
export function enableArtifacts(items: DisableItem[], opts?: IntrospectOptions): DisableResult[];
export function listDisabled(opts?: IntrospectOptions): DisabledArtifact[]; // for the payload
```

- **Batch, never-throws** (mirrors `installSkill`): each item is processed
  independently; a failure maps to `{ ok:false, message }` and does not abort the
  rest.
- **Strict validation before any filesystem move**: `name` and `source` matched
  against strict regexes and `..` rejected explicitly (defense-in-depth identical
  to `installSkill`), so a crafted `name` cannot traverse out of a skills root.
- **No clobber**: disable fails an item if the archive target already exists;
  enable fails if the live target already exists. Both surface a clear message.
- settings.json edits **preserve unrelated keys and formatting intent** (parse →
  mutate the one key → write with 2-space JSON). A missing/…​unparseable
  `settings.json` is created/replaced only for the managed keys as needed.

`listDisabled` enumerates from three sources: `enabledPlugins` entries that are
`false`, `disabledMcpjsonServers` names, `<archive>/skills/**`, and
`<archive>/mcp/*.json`.

## API (`src/gem.controller.ts`, `originGuard`-protected like all `/api`)

```
POST /api/optimize/disable   body { artifacts: DisableItem[] }  → { results: DisableResult[] }
POST /api/optimize/enable    body { artifacts: DisableItem[] }  → { results: DisableResult[] }
GET  /api/optimize           payload gains  disabled: DisabledArtifact[]
```

Folding `disabled` into the existing `GET /api/optimize` payload keeps the panel
**single-fetch** (matching `Optimize/index.tsx`). Endpoints delegate straight to
the capture module; no business logic in the controller (matches
`optimizeDiscoverInstall`).

Zod: `DisableItemSchema` / `DisableResultSchema` / `DisabledArtifactSchema` added
to `routes.ts` (console contract) and mirrored in the controller, per the
existing dual-schema convention.

## Frontend (`packages/console/src/panels/Optimize/Dashboard.tsx`)

- **Prune table**: leading checkbox column. Eligible rows (non-distilled,
  non-project) get a checkbox; ineligible rows render without one and keep their
  read-only hint. A header action **"Disable selected (N)"** appears when ≥1 row
  is checked; a header checkbox toggles select-all over eligible rows.
- On confirm, `POST /api/optimize/disable` with the checked items, then call the
  existing `onRefresh()` to re-fetch. Per-item failures surface inline (reuse the
  Discover install result banner pattern).
- **New "Disabled" section** below Instructions health: lists
  `payload.disabled`, each row with a **Re-enable** button → `POST
  /api/optimize/enable` for that one item → `onRefresh()`.
- Selection state is local `useState` in `Dashboard`; nothing persists across
  refetch (a disabled row simply leaves the Prune list and appears under
  Disabled).

## Data flow

1. `GET /api/optimize` → `introspectConfig()` (fresh; disabled skills already
   gone because their folders moved, disabled plugins already skipped) +
   `listDisabled()` → payload with `artifacts` and `disabled`.
2. User checks rows → **Disable selected** → `POST /disable` → capture module
   moves/flags → results → `onRefresh()` → step 1 reflects new reality.
3. Re-enable is the exact inverse.

No new caching. The 15s usage-scan cache is unaffected (disable changes inventory,
not transcript usage), and `introspectConfig` is always read fresh.

## Error handling

- Invalid `name`/`source` → per-item `ok:false, "invalid artifact reference"`.
- Archive/live target already exists → per-item `ok:false` with the path in the
  message; nothing moved.
- Unreadable/malformed `settings.json` → managed keys are (re)written safely;
  unrelated content loss is avoided by parse-then-mutate.
- Whole-batch endpoint never rejects; partial success is normal and reported
  per item.

## Testing (`packages/capture/src/__tests__/disableArtifact.test.ts`)

Against a temp fake home (temp `.claude`, `.agents`, `.codex`, `.hermes`, and
`.agentgem`), using dir overrides:

- **skill round-trip, each agent**: seed a skill under each of the four roots →
  disable → folder now under `<archive>/skills/<source>/<name>`, gone from live
  root, `introspectConfig` no longer lists it → enable → back in place.
- **name collision across agents**: same `<name>` under `standalone` and `codex`
  both disabled → archived under distinct `<source>` subdirs, no collision.
- **plugin**: `enabledPlugins["X"]=true` → disable → `false`, `introspectConfig`
  drops the plugin's artifacts → enable → `true`.
- **MCP via `.mcp.json`**: disable → name in `disabledMcpjsonServers` → enable →
  removed.
- **MCP via `settings.json`**: disable → entry stashed to
  `<archive>/mcp/<name>.json` and removed from live `mcpServers` → enable →
  restored, stash deleted.
- **validation**: `name: "../evil"` rejected, nothing moved.
- **no-clobber**: pre-existing archive target → disable fails cleanly.
- **batch resilience**: one bad item among good ones → good ones still applied,
  bad one reported `ok:false`.
- **listDisabled**: reports all four kinds after disabling one of each.

Frontend: extend `Optimize` panel tests — checkbox selection enables the header
button; clicking it posts the selected items; a `disabled` payload renders the
Disabled section with working Re-enable buttons (mock the routes as existing
tests do).

## Consistency / conceptual-integrity notes

- The write path imports the **same** source→root map as `introspect.ts` (extract
  it to a shared helper so the two can never diverge — a small, in-scope
  improvement).
- Archive naming is agent-neutral; per-`source` subdirs preserve each agent's
  namespace.
- `distilled-draft` MCP-changeHint quirk in `optimizeAnalyze.ts` (it maps
  `distilled-draft`→`~/.claude/skills`) is sidestepped by excluding those rows
  from eligibility rather than "fixing" an unrelated function.
