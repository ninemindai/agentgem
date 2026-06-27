# Usage-aware Lapidary Ledger — sort & filter by artifact usage

Date: 2026-06-27
Status: Approved (design)

## Problem

The Lapidary Ledger (`#inventory` pane in `src/public/index.html`, rendered by
`renderInventoryPane()`) lists the active testbed's discovered artifacts — skills,
MCP servers, hooks, instructions — but shows **no usage information**. There is no
way to tell, from the ledger, which of these artifacts the local agent actually
*used* in past sessions versus which are merely installed-but-dormant.

Separately, the codebase already computes exactly this usage signal: `scanWorkflow()`
in `src/gem/workflowScan.ts` parses session transcripts and produces an
`ArtifactUsage[]` carrying `invocations`, `sessionsUsedIn`, and `lastUsedMs` per
artifact — but that data only feeds the Analyze recommendation modal, never the ledger.

We want to **join the usage plane onto the ledger** so the user can:

- (a) sort artifacts by usage count and by last-used time, and
- (b) hide artifacts that were never used (default to showing only used ones).

## Background: two data planes

| Plane | Source | Carries usage? | Where it surfaces today |
|-------|--------|----------------|-------------------------|
| Installed inventory | `GET /api/inventory` → `introspectAll()` | No | The ledger (`#inventory`) |
| Usage | `scanWorkflow()` (transcript parse, synchronous, no LLM) | Yes (`invocations`, `sessionsUsedIn`, `lastUsedMs`) | Analyze recommendation modal only |

Natural join key: `(type, name, root)`. This feature is **wiring**, not new
computation — the usage numbers already exist; they just aren't shown on the ledger.

Note: the expensive (~15–20s, cached) part of "Analyze" is the **ACP agent**, not the
scan. `scanWorkflow()` itself is a cheap synchronous transcript parse. Running it on
ledger load is acceptable.

## Decisions (locked)

1. **Usage data source:** scan on ledger load (always-fresh).
2. **Sort UI:** two clickable header toggles — **Uses** and **Last used** — each
   cycles desc → asc → off, mutually exclusive.
3. **"Used only" filter:** a toggle, **on by default**.
4. **Passive artifacts:** Instructions and Hooks are **always exempt** from the
   "Used only" filter (they have no `tool_use`, so "used" is meaningless for them).
   The filter applies only to Skills and MCP servers.

## Design

### 1. Server — new `GET /api/usage` endpoint

In `src/gem.controller.ts`, add an endpoint mirroring the inventory endpoint's query
shape (`DirQuerySchema`: `dir` + `projects`):

```
@get("/usage", { query: DirQuerySchema, response: UsageSchema })
async usage(input): Promise<UsageResponse>
```

Behaviour:

1. Build the inventory for the requested project(s) via `introspectAll()` (same call
   the inventory endpoint makes) to get the `ScanInventory` shape `scanWorkflow` needs.
2. Resolve the project's Claude transcript paths (the helper `scanWorkflow` already
   relies on — `claudeTranscriptsForCwd()` in `workflowScan.ts`).
3. Run `scanWorkflow(paths, inv)` and return its `artifacts: ArtifactUsage[]`.
4. **Best-effort:** wrap in try/catch; any failure returns `{ artifacts: [] }`. The
   ledger must still render if scanning fails (no transcripts, parse error, etc.).

Response schema (`UsageSchema` in `src/schemas.ts`) — a thin projection of
`ArtifactUsage`, only the fields the client needs:

```ts
const UsageItemSchema = z.object({
  type: z.string(),            // "skill" | "mcp_server" | "hook" | "instructions" | "channel"
  name: z.string(),
  root: z.string().nullable(),
  invocations: z.number(),
  sessionsUsedIn: z.number(),
  lastUsedMs: z.number().nullable(),
});
const UsageSchema = z.object({ artifacts: z.array(UsageItemSchema) });
```

Kept **separate** from `/api/inventory` so inventory stays fast and usage is an
optional, best-effort decoration.

### 2. Client — join usage onto rows

In `load()` (index.html), after `renderInventoryPane()` runs, fetch
`/api/usage` + the same `projects` query string, then decorate rows:

- Build a map keyed `${type}|${name}|${root}` → `{ invocations, lastUsedMs }`.
- Kind→type mapping for the join:
  `projectSkills→skill`, `projectMcpServers→mcp_server`, `projectHooks→hook`,
  `projectInstructions→instructions`. `root = activeTestbed`.
- For each `#inventory label.row`, set `data-invocations` (default `0`) and
  `data-lastused` (epoch ms, default empty), and append a small inline badge to the
  row, e.g. `· 12 uses · Jun 20` (omit the date when `lastUsedMs` is null; show
  nothing extra when invocations is 0 and the type is passive).

Decoration is a separate pass so it can run after a best-effort fetch without
blocking first paint, and re-running `renderInventoryPane()` (e.g. after a distilled
draft injection) simply re-applies it.

### 3. Sort — two clickable headers

Add two small toggle controls to the existing filter bar (near the search/source/
agent/type controls): **Uses** and **Last used**. Each click cycles
`desc → asc → off`; activating one resets the other to off (mutually exclusive).

When a sort is active, reorder rows **within each group** (`#inventory .group`) by
re-appending the `label.row` nodes in sorted order:

- **Uses:** numeric on `data-invocations`.
- **Last used:** numeric on `data-lastused` (empty/0 sorts last in desc).

Off (default) restores today's name/insertion order — capture the original order once
(e.g. a `data-order` index stamped at render) so "off" is restorable without a refetch.

Sorting stays *within groups* to preserve the ledger's Skills / MCP / Hooks /
Instructions structure, which the group styling and rise animations depend on.

### 4. "Used only" toggle — on by default

Add a `Used only` checkbox to the filter bar, `checked` by default. Fold it into the
existing `filterRows()` predicate so it composes with search + source + agent + type:

```
const usedOnly = usedOnlyCheckbox.checked;
const passive = type === "instructions" || type === "hook";
const matchUsed = !usedOnly || passive || Number(row.dataset.invocations) > 0;
```

Because it is on by default, the ledger opens showing only Skills/MCP servers that
actually fired, plus all passive artifacts. Unticking reveals dormant installs.

The group header counts (`— showing N`) already update from `filterRows()`, so they
reflect the filtered set automatically.

## Data flow

```
load()
  ├─ GET /api/inventory ──→ renderInventoryPane()   (rows, no usage)
  └─ GET /api/usage     ──→ decorateUsage()         (data-invocations/-lastused + badge)
                                   │
                          filterRows()  ← search + source + agent + type + Used-only
                                   │
                          sortRows()    ← Uses / Last used header toggles (within groups)
```

Server: `GET /api/usage` → `introspectAll()` → transcript paths → `scanWorkflow()`
→ `ArtifactUsage[]` (best-effort; `[]` on any error).

## Error handling

- `/api/usage` never throws to the client: try/catch → `{ artifacts: [] }`.
- Client `decorateUsage()` tolerates a missing/empty response: rows simply keep
  `data-invocations="0"`, sorts degrade gracefully (everything equal → stable order),
  and "Used only" shows only passive artifacts (acceptable — no usage signal exists).
- A usage entry with no matching row is ignored; a row with no usage entry defaults
  to zero. The join never errors on mismatch.

## Testing

Server:
- `GET /api/usage` returns artifacts with `invocations`/`lastUsedMs` for a fixture
  project that has transcripts exercising a known skill.
- Endpoint returns `{ artifacts: [] }` (not 500) when the project has no transcripts
  or scanning throws.

Client (where the existing index.html behaviour is covered — match current test
style; if there is no client harness, cover the join/sort/filter logic by extracting
the pure helpers and unit-testing them):
- Join maps `projectSkills`/`projectMcpServers`/`projectHooks` kinds to the right
  usage types and stamps `data-invocations`/`data-lastused`.
- Sort toggle cycles desc → asc → off and reorders within a group; "off" restores
  original order.
- "Used only" (on) hides a zero-invocation Skill but keeps an Instruction and a Hook;
  composes correctly with an active search/type filter.

## Out of scope (YAGNI)

- Caching the raw scan (the full-analysis cache already exists; the bare scan is cheap
  enough to run on load — revisit only if profiling shows a problem).
- Global/plugin artifacts in the ledger (the ledger shows only the active testbed's
  project artifacts; globals are reached via Import — unchanged).
- Sorting across groups / flattening the grouped layout.
- Surfacing `sessionsUsedIn` in the UI (captured server-side, not shown; can be added
  to the badge later if wanted).
```
