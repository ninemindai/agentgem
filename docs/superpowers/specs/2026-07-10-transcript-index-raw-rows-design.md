# Transcript index: raw rows, resolved at query time

**Date:** 2026-07-10
**Status:** Approved design, ready for planning
**Branch:** `perf/transcript-index-raw-rows`

## Problem

The transcript index is already incremental per file (`transcript_file` keyed on `mtime_ms + size`,
reparsing only what changed). One thing throws that away: `inv_digest`.

`global_usage` stores **resolved** rows (`type`, `name`). When the global inventory changes, resolution
changes, so every stored row is suspect and `doSync` wipes the table and reparses the whole corpus
(`packages/capture/src/transcriptIndex.ts:117-122`).

Measured on a 3,554-transcript / 3.1 GB home: that rebuild takes **17.4 s**, synchronously, on the
server's event loop. `inv_digest` hashes skill names, MCP server names, and hook `name`/`event`/`config`
(`packages/capture/src/globalUsage.ts:32-41`), so **installing any skill triggers it**. During the session
that produced this spec, the digest changed from `2369e28e…` to `62cfba85…` on its own — this is ordinary
churn, not an edge case.

## The observation

Parsing a transcript does not depend on the inventory. The inventory only decides what a parsed token
**resolves to**. The two stages are fused, and the fusion forces 3.1 GB to be re-read to recompute a
mapping over ~98 distinct tokens.

Skills and MCP servers are **token-driven** — the transcript yields the token:

```js
// workflowScan.ts:445-451
if (name === "Skill" && typeof block.input?.skill === "string") {
  const skill = block.input.skill;                     // raw token, e.g. "superpowers:brainstorming"
  const g = matchSkill(global.skills, skill);          // inventory only MAPS it
}
// workflowScan.ts:390
matchSkill = (list, skill) => list.find((s) => s.name === skill || skill.endsWith(`:${s.name}`));
```

Hooks are **inventory-driven** — there is no token to extract; you can only tell a hook fired by
searching each record for *that hook's own* event name and command basename:

```js
// workflowScan.ts:478-489
if (flat.includes("hook success") || /Hook\b/.test(flat)) {
  for (const h of list) {                              // iterate the INVENTORY
    const base = firstHookCommand(h.config)?.split("/").pop();
    if ((h.event && flat.includes(h.event)) || (base && flat.includes(base))) touch(ns, h.name, "hook", ms, path);
  }
}
```

That asymmetry is why `inv_digest` must hash hook `config`, and it is what bounds this design.

### Measured scale

| | measured |
|---|---|
| distinct raw skill tokens in the entire 3.1 GB corpus | **63** |
| distinct `mcp__server__` prefixes | **35** |
| resolving 5,000 raw rows against a 413-skill inventory | **25.5 ms** (MCP: 1 ms) |
| live index rows | 810 (478 skill, 47 mcp_server, 285 hook) |
| full reparse forced by a digest change | **17.4 s, synchronous** |
| inventory composition | 413 skills, 11 MCP servers, 12 hooks |

The churn that triggers wipes is overwhelmingly skills — 424 of 436 artifacts are token-driven.

## Goal

Store what the **file** determines. Resolve what the **inventory** determines, at query time.
Installing a skill or MCP server must reparse **nothing**.

### Non-goals

- **Making hooks raw.** Hook matching is a loose `flat.includes(...)` over arbitrary record text.
  Inverting that into extractable tokens is a fidelity risk for 12 of 436 artifacts. Hooks stay
  resolved-at-parse, and `hook_digest` still forces a reparse when a hook changes. Deliberate.
- **Moving the first build off the event loop.** The cold build still parses 3.1 GB once, synchronously.
  Tracked separately (see *Follow-up*); it is a second, independent change and this spec is already a
  persistent-format change.
- **Changing `/api/usage`'s response shape.** Output must be byte-identical; the differential test is
  the gate.
- **Touching the fallback JSON cache** (`global-usage-cache.json`) or the warm pass.

## Schema

```sql
-- File-derived ONLY. A pure function of the file's bytes. Never invalidated by an inventory change.
raw_usage(path, kind, token, invocations, last_used_ms)   PRIMARY KEY (path, kind, token)
                                                          -- kind: 'skill' | 'mcp_server'

-- Inventory-derived: a hook is matched by its own event/command, so it must be resolved at parse.
hook_usage(path, name, invocations, last_used_ms)         PRIMARY KEY (path, name)

transcript_file(path, mtime_ms, size)   -- unchanged; still the incremental key
meta: schema_version, hook_digest       -- `inv_digest` is DELETED
```

`global_usage` is replaced by these two tables.

### `sessions_used_in` is deleted as a column

`touch()`'s fifth parameter is *named* `sessionId` (`workflowScan.ts:382`) but **every one of its five
call sites passes `path`** (`:450`, `:451`, `:457`, `:458`, `:484`). So `acc.sessions` is a set of paths,
and `sessionsUsedIn` has always meant *distinct transcript files*.

Verified against the live index: `SUM(sessions_used_in) == COUNT(DISTINCT path)` for all 810 rows,
**zero mismatches**. (Independently: 0 of 400 sampled transcripts contain more than one `sessionId`.)

So `sessionsUsedIn` is computed at query time as `COUNT(DISTINCT path)`. This **dissolves** the
double-count hazard rather than working around it: had we stored a per-row session count, two raw tokens
resolving to one artifact within one file would have summed to 2. Nothing is stored, so nothing can
double-count.

## Invalidation

| trigger | today | after |
|---|---|---|
| install / remove / rename a **skill** (413) | wipe + reparse, **17.4 s** | **nothing** |
| add / remove an **MCP server** (11) | wipe + reparse, 17.4 s | **nothing** |
| change a **hook** (12) | wipe + reparse, 17.4 s | wipe `hook_usage` + reparse (unchanged) |
| a transcript changes | reparse that file | reparse that file |
| `schema_version` bump | wipe + rebuild | wipe + rebuild |

A hook change must re-read every file, because the parse itself depends on the hook's event/command.
Implementation: on `hook_digest` mismatch, `DELETE FROM hook_usage` **and** `DELETE FROM transcript_file`
(forcing reparse). `raw_usage` **survives** — the reparse re-upserts identical rows.

## Query-time resolution

```
rows = SELECT path, kind, token, invocations, last_used_ms FROM raw_usage
for each row:
    name = kind === 'skill' ? matchSkill(inv.skills, token) : matchMcpServer(token, inv.mcpServers)
    if (!name) continue                                    -- unresolved: retained in the table, omitted from output
group by (type, name):
    invocations    = SUM(invocations)
    sessionsUsedIn = COUNT(DISTINCT path)
    lastUsedMs     = MAX(last_used_ms)

hooks: SELECT name, SUM(invocations), COUNT(DISTINCT path), MAX(last_used_ms) FROM hook_usage GROUP BY name
```

`matchSkill` and `matchMcpServer` move verbatim from `workflowScan.ts` into a shared, exported resolver so
mint-time and query-time cannot drift. They are **order-dependent** (`find`, first match wins over
inventory order), so the resolver must iterate the inventory in the order `introspectConfig` returns it.

**A property falls out for free.** Unresolved tokens stay in `raw_usage` instead of being discarded into
an in-memory `unresolved` bucket. Install a skill you had used before it was in your inventory and its
historical usage appears immediately — which is exactly what the wipe was trying to achieve, without
reading a single file.

## Data flow

```
sync (per changed file)
  └─ parse file → { rawTokens: [{kind, token, invocations, lastMs}], hookHits: [{name, ...}] }
       └─ upsert raw_usage (inventory-independent) + hook_usage (needs current hook inventory)

query (every /api/usage?scope=global)
  └─ read raw_usage  → resolve against CURRENT inventory → aggregate
     read hook_usage → aggregate
```

## Error handling

- An unparseable transcript contributes nothing (`try/catch` per file, as today).
- A token that resolves to nothing is retained in `raw_usage` and omitted from the response. It is not an
  error.
- A corrupt/old-schema db is handled by the existing `schema_version` guard: wipe derived rows, rebuild.
- The endpoint's existing fallback (`getGlobalUsageIndexed` rejects → `computeGlobalUsage`) is untouched.

## Migration

`SCHEMA_VERSION` `"1"` → `"2"`. The existing guard (`transcriptIndex.ts:83-89`) already drops derived rows
on mismatch, so upgrade costs exactly **one 17.4 s rebuild**, then never again for skills/MCP. No
hand-written migration; `meta.inv_digest` is left orphaned and ignored (harmless), or dropped in the same
guard.

## Testing

- **Differential test (the gate).** Over a fixture corpus, assert the new resolver's output is
  **byte-identical** to today's `computeGlobalUsage` — every artifact's `type`, `name`, `invocations`,
  `sessionsUsedIn`, `lastUsedMs`. Not a spot check; full equality. This is what protects the lossy,
  order-dependent matchers.
- **No-reparse test.** Sync once; add a skill to the inventory; query again. Assert the previously
  unresolved token now resolves, **and that `parseFile` was not called** (spy on it). This is the whole
  point of the change.
- **Hook-digest test.** Changing a hook's `config` clears `hook_usage`, forces a reparse, and leaves
  `raw_usage` intact.
- **`sessionsUsedIn` equivalence test.** Two distinct raw tokens resolving to one artifact within one
  file must yield `sessionsUsedIn === 1`, not 2.
- **Migration test.** Opening a `schema_version = "1"` db rebuilds into the new tables.
- **Not asserted in CI:** the 17.4 s → 0 s improvement. Verified by measurement, because asserting a
  wall-clock number in a unit test tests the fixture.

## Verification

Measured against a real home, not asserted:

| | before | expected after |
|---|---|---|
| install a skill, then `GET /api/usage` | 17.4 s (full reparse) | < 0.15 s |
| unchanged corpus, warm | 0.10 s | 0.10 s |
| `/api/usage` output | baseline | **byte-identical** |

## Follow-up (tracked separately)

The **first** build still parses 3.1 GB once, synchronously, on the event loop — the residual blocker
after #265/#267. It composes cleanly with this change: parsing is the expensive part and SQLite writes are
cheap, so a worker can parse files and post rows back to the main thread, which owns the process-wide
`DatabaseSync` handle (`globalUsage.ts:48-60`). That sidesteps the shared-handle problem that kept the
`usage` warmable on the main thread. Separate spec.

## Accepted costs

- **A hook change still reparses the corpus** (17.4 s). 12 artifacts, rarely edited. Making hooks raw
  would require inverting a substring heuristic over arbitrary text.
- **One 17.4 s rebuild on upgrade**, via the `schema_version` guard.
- **`raw_usage` is slightly larger than `global_usage`** for skills/MCP: rows key on the raw token rather
  than the resolved name, so two tokens mapping to one skill become two rows. Bounded by 63 distinct skill
  tokens corpus-wide.
