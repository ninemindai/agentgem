# Testbed on-ramp simplification — design

**Date:** 2026-06-22
**Status:** Approved for planning
**Topic:** Simplify the `agentgem` first-run / testbed-selection UX

## Problem

The current on-ramp makes the user re-find a project they are almost certainly
already standing in, and the zero-config experience is a dead end.

Concretely, today:

1. `agentgem` boots a server and reads nothing about `process.cwd()`.
2. The UI is testbed-gated — nothing loads until a testbed is chosen.
3. Clicking **Create / open testbed…** opens a modal that forks on an env flag:
   - `AGENTGEM_RECENT_PROJECTS=1` → a list scraped from `~/.claude/projects/*.jsonl`
     and `~/.codex/sessions/**/rollout-*.jsonl` (by `cwd` + mtime).
   - **default (unset)** → a "suggestions are off, restart with the flag" message,
     forcing the user into **Browse folder…**.
4. Browse → OS picker → `GET /api/testbed/detect` → if the flavor is ambiguous, a
   browser `prompt("claude / codex / hermes")`, then a second `prompt()` for the name.

Two structural problems:

- **The cwd is ignored.** The overwhelmingly likely answer ("use the folder I just
  `cd`'d into") is never offered.
- **"History" is conflated with a cross-repo session-log scan**, which is off by
  default — so the default user sees neither a useful recents list nor their cwd.

## Goals

- Land the common case (cwd is the project) in **one click**, with explicit consent
  before any files are written.
- Replace the env-flag fork and the two `prompt()` dialogs with a single front-door
  screen.
- Give "Recent" a real, accurate meaning: testbeds the user has opened *in agentgem*.
- Net-delete the cross-repo session-log scan rather than carry it dormant.

## Non-goals

- No change to the import flow (`/api/testbed/import`), inventory introspection, the
  Lapidary Ledger preview, or the gem/target/deploy pipeline.
- No change to the flavor model (`claude` / `codex` / `hermes`) or the scaffold
  skeletons in `TESTBED_FLAVORS`.
- No multi-testbed / workspace-switching rework beyond the recents list.

## Decisions (locked during brainstorming)

1. **First-run default = pre-select cwd, one-click confirm** (not auto-adopt, not
   an always-on picker). The confirm click is the consent point before scaffold
   writes anything.
2. **Recent source = agentgem's own persisted history** (`~/.agentgem/recents.json`),
   not the session-log scan, and *not* with the scan as a fallback for empty history.
3. **Delete the session-log scan path entirely.**

## Design

### 1. Startup probe (read-only)

On boot the server computes a cwd suggestion. The probe writes nothing.

- **flavor:** reuse `detectFlavor(root)` from `gem/testbedFlavors.ts` — single marker
  match (`.claude/`/`CLAUDE.md`, `.codex/`/`AGENTS.md`, `.hermes/`) → that flavor;
  none or several → `null`.
- **adoptable fallback:** if `detectFlavor` is `null` but `.git/` is present, the
  folder is still *adoptable* (`looksLikeProject: true`, `flavor: null`); the user
  chooses the flavor on the confirm screen.
- **otherwise:** `looksLikeProject: false` — cwd is not offered.

New endpoint:

```
GET /api/testbed/suggestion
→ { cwd: string, looksLikeProject: boolean, flavor: TestbedFlavorId | null, name: string }
```

`name` defaults to `basename(cwd)`. `cwd` is `process.cwd()` resolved through
`resolveProject`. This is a dedicated endpoint (not folded into `/api/inventory`)
so the UI can render the front door before any inventory work.

### 2. Single front-door screen

Replaces the recent-projects modal and its env-flag fork. One screen, two stacked
blocks, no `prompt()` dialogs:

```
┌─ Open a testbed ───────────────────────────────┐
│  This folder looks like a [claude] project      │   ← only if looksLikeProject
│  ~/Projects/ninemind/agentgem                   │
│  name: [ agentgem            ]   [ Use this ▸ ]  │
│ ─────────────────────────────────────────────── │
│  Recent          (testbeds you've opened here)  │
│   • acme-bot      codex   2d ago                 │
│   • flue-demo     claude  5d ago     (missing)   │
│  [ Browse for another folder… ]                  │
└─────────────────────────────────────────────────┘
```

- **Top block (only when `looksLikeProject`):** flavor label + editable name +
  **Use this ▸**. When `flavor` is `null` (adoptable git repo), render a small inline
  3-way toggle (claude / codex / hermes) in place of the label — *not* a browser
  prompt. Clicking **Use this** is the consent point: it calls the existing
  scaffold/open path (which writes only the files that are absent — see
  `writeIfAbsent` / `scaffold` in `TESTBED_FLAVORS`).
- **Bottom block (always):** the **Recent** list from `recents.json`, then **Browse
  for another folder…**. Browse keeps the OS picker (`GET /api/pick-folder`) →
  `GET /api/testbed/detect` → inline confirm (same editable-name + inline flavor
  toggle), never a `prompt()`.
- **Empty state:** if cwd is not adoptable *and* recents is empty (first-ever run),
  the screen shows only **Browse for another folder…** with a one-line hint.

### 3. Persisted recents

- **Location:** `~/.agentgem/recents.json`. Derive the dir from `homedir()` (extend
  `resolveDir.ts` with a small `agentgemDir()` helper rather than overloading
  `resolveDirs`, which is scoped to harness-home discovery).
- **Shape:**

  ```json
  [{ "path": "/abs/path", "flavor": "claude", "name": "agentgem", "lastUsed": "2026-06-22T13:34:10.000Z" }]
  ```

  Deduped by `path` (most recent wins), sorted newest-first, capped at 10.
- **Write:** every successful open — cwd-confirm, recent-click, or browse-confirm —
  upserts an entry. A single shared open handler does the upsert so all three paths
  stay consistent.
- **Read / staleness:** `GET /api/testbed/recents` returns the list, each entry
  carrying `exists` (via `existsSync`) so the UI can show a "missing" badge. Clicking
  a missing entry prunes it and re-renders rather than failing.

### 4. Endpoints

| Endpoint | Change |
|---|---|
| `GET /api/testbed/suggestion` | **new** — cwd probe (§1) |
| `GET /api/testbed/recents` | **new** — read `recents.json` with `exists` flags |
| `GET /api/testbed/detect` | unchanged (still used by Browse) |
| `POST /api/testbed/scaffold` | unchanged behavior; the shared open handler upserts a recents entry on success |
| `GET /api/testbed/projects` | **deleted** |

### 5. Deletions

- `GET /api/testbed/projects` handler (`gem.controller.ts`) + `recentProjectsEnabled()`.
- `AGENTGEM_RECENT_PROJECTS` env handling and all references.
- The session-log scan in `gem/testbedFlavors.ts`:
  `discoverProjects`, `discoverClaudeProjects`, `discoverCodexProjects`, `newestJsonl`,
  `walkJsonl`, `readHead`, `firstLine`, `cachedCwd`/`cwdByFile`, `readClaudeCwd`,
  `readCodexMetaCwd`, `CWD_RE`, the `RawProject` / `ProjectCandidate` types, and the
  `discoverProjects` member on `TestbedFlavor` (drop it from the interface and from
  each flavor entry).
- `TestbedProjectsQuerySchema` / `TestbedProjectsResponseSchema` and the
  `ProjectCandidate` schema in `schemas.ts`.
- The "suggestions are off…" UI branch in `public/index.html`, plus both `prompt()`
  calls (flavor + name).

Note: `safeMtime` and `statSync` usage may have no remaining callers after the scan
is removed — delete if orphaned, keep if still used by introspection.

## Data flow (happy path)

```
agentgem (cwd = ~/Projects/foo)
  → server boots
  → UI loads, calls GET /api/testbed/suggestion
      → { cwd, looksLikeProject:true, flavor:"claude", name:"foo" }
  → front door shows "This folder looks like a [claude] project … [Use this ▸]"
  → user clicks Use this
      → POST /api/testbed/scaffold { root:cwd, name:"foo", flavor:"claude" }
          → writes only absent files (already a claude project → writes nothing)
          → upsert ~/.agentgem/recents.json
      → testbed active → inventory + Lapidary Ledger render
```

## Error handling

- **`recents.json` unreadable / malformed:** treat as empty list (try/catch → `[]`),
  matching the defensive `readJsonFile` pattern already in `testbedFlavors.ts`.
- **`~/.agentgem/` not writable:** the open still succeeds; the recents upsert is
  best-effort and logs a warning rather than failing the open.
- **Stale recent clicked:** prune the entry, re-render, surface a brief "folder no
  longer exists" notice. No exception bubbles to the user.
- **cwd probe throws** (permissions, exotic path): return `looksLikeProject:false`
  so the front door degrades to Recent + Browse.
- **Ambiguous/unknown flavor on Browse or adoptable cwd:** inline 3-way toggle,
  default selection none — **Use this** is disabled until a flavor is chosen.

## Testing

Extend the existing `gem/__tests__/testbedFlavors.test.ts` /
`gem.controller.test.ts` patterns (vitest, temp dirs under `os.tmpdir()`):

- **suggestion probe:** claude-marker dir → `flavor:"claude"`; bare git repo →
  `looksLikeProject:true, flavor:null`; plain empty dir → `looksLikeProject:false`.
- **recents store:** upsert dedups by path and keeps newest; cap at 10; malformed
  file → `[]`; `exists:false` for a removed path.
- **open handler:** scaffold-then-upsert writes a recents entry; opening an existing
  claude project writes no scaffold files but still records a recent.
- **deletion regression:** `/api/testbed/projects` is gone (route returns 404) and no
  code references `AGENTGEM_RECENT_PROJECTS`.

## Open questions

None. (If keeping the session-scan dormant is later desired, it can be reinstated as
an optional fallback per the "Both" option considered during brainstorming.)
