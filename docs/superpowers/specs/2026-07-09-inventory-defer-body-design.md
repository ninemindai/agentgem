# Inventory deferred bodies

**Date:** 2026-07-09
**Status:** Approved design, ready for planning
**Branch:** `feat/inventory-defer-body`

## Problem

`GET /api/inventory` ships **6.13 MB**. Artifact bodies — the full `SKILL.md` of each of 413
installed skills, plus 25 subagents and 21 instructions — account for **5.81 MB of raw
content**, and stripping them measures the payload down to **0.134 MB**: bodies are **97.8%
of the wire bytes** once JSON escaping is counted. Those bodies are rendered only when a row
is expanded (`Curate/index.tsx:386`) or a modal is opened (`Setup/index.tsx:298`). First
paint never reads them.

The endpoint is not slow — measured at **49–77 ms**, with `JSON.parse` at 7–10 ms, once the
warm-pass event-loop stall (#265, #267) was removed. So this is not a latency emergency. It
is three real costs:

- **Memory.** 6.13 MB is parsed into JS objects on every Curate and Setup mount, and grows
  linearly with installed artifacts.
- **Scaling.** 413 skills today. The payload is a function of how much the user has installed.
- **Hygiene.** `mcpHostTools.getInventory` (`packages/console/src/panels/Play/mcpHostTools.ts:56-58`)
  forwards the entire inventory — all 5.81 MB of bodies — opaquely into sealed miniapp iframes,
  for a capability documented as *"Get the viewer's local inventory (skills, MCP servers,
  projects)."* Bodies were never the point.

A list endpoint should not ship every body.

## Goal

Add an opt-in flag that returns artifact **metadata plus an address**, and a second endpoint
that resolves an address to its body on demand.

Expected: **6.13 MB → ~0.16 MB** (0.134 MB metadata + ~28 KB of ids).

### Non-goals

- **Changing the default.** `body=full` stays the default; this change is purely additive.
  Flipping the default is a separate PR once no caller depends on the old shape.
- **A miniapp body host-tool.** Neither miniapp that calls `agentgem_get_inventory`
  (`agentgem`, `setup-explorer`) reads `.content`. Adding `agentgem_get_artifact_content`
  for a consumer that does not exist is speculative capability surface.
- **Loosening the gem contract.** `SkillArtifactSchema` is a member of `GemArtifactSchema`
  (`src/schemas.ts:111-119`), the gem-archive contract. `content` stays required there.
- **Memoizing introspect.** Each body fetch re-runs `introspectConfig` (22 ms, measured).
  Fine for one expand; see *Accepted costs*.
- **The rest of the entity-address scheme.** Only `workspace/*` is built here.

## The address

`docs/superpowers/specs/2026-07-09-entity-address-scheme-design.md` — which lives on the
unmerged `docs/entity-address-scheme` branch, **not on `main`**; read it with
`git show docs/entity-address-scheme:docs/superpowers/specs/2026-07-09-entity-address-scheme-design.md`
— declares a **Workspace artifact** entity at canonical path `workspace/skills/build`, marked
*new* — nothing builds it yet. It also names the exact defect we would otherwise repeat:
the console's `#/setup/skills?a=build` "cannot distinguish your local `build` skill from
`@acme/tetris`'s `build` skill."

That scheme's stated purpose is to stop identifier schemes proliferating ("three identifier
schemes coexist and none spans the set"). So the inventory `id` **is** the canonical entity
path, not a fourth scheme. This PR builds its first conformer.

### Two deviations from the written scheme, both forced by real data

1. **A `source` segment.** Plugin artifact names are **bare**, not namespaced —
   `code-reviewer` from `plugin:feature-dev@claude-plugins-official`. There are zero
   collisions across 413 skills / 25 subagents / 21 instructions today, but two plugins
   shipping one skill name is a matter of time, and `workspace/skills/<name>` has nothing to
   disambiguate with. Rule 2 of the scheme says *nesting expresses containment*; a source is
   a container. So: `workspace/skills/<source>/<name>`.

2. **Percent-encoded segments.** The instruction `codex:rules/default.rules` already contains
   a `/`. Unencoded, a path-shaped id silently mis-parses. Every segment is
   `encodeURIComponent`-ed.

```
workspace/skills/standalone/agentback
workspace/skills/plugin%3Afeature-dev%40claude-plugins-official/code-reviewer
workspace/subagents/agent/code-architect
workspace/instructions/codex%3Arules%2Fdefault.rules
```

### Arity

`instructions` artifacts carry **no `source` field** (`introspect.ts` yields `type`, `name`,
`content` only). Their path therefore has three segments where skills and subagents have four.
The parser branches on the collection rather than inferring from segment count, and rather
than inventing a fake `source: "local"` to keep the shape rectangular. This is stated, not
implied, because it is the kind of asymmetry that gets "cleaned up" into a bug.

## Components

### `packages/model/src/entityPath.ts` (new)

The artifact that makes this a scheme rather than a convention. Exports **workspace
collections only**:

```ts
export type WorkspaceCollection = "skills" | "subagents" | "instructions";
export function workspaceArtifactPath(a: { type; name; source? }): string;
export function parseWorkspaceArtifactPath(id: string):
  { collection: WorkspaceCollection; source?: string; name: string } | null;
```

Returns `null` — never throws — on a malformed id, so the route answers `404` rather than
`500` for a hand-typed URL.

### Server (`src/gem.controller.ts`, `src/schemas.ts`)

- `DirQuerySchema` gains `body: z.enum(["full", "defer"]).optional()`, default `full`.
- `defer` strips `content` from `skills`, `subagents`, `instructions`. `hook` and
  `mcp_server` have no `content` and are untouched.
- Every artifact gains `id`, in **both** modes — it is the address, not a body.
- `id` is minted in the **controller**, not in `introspectConfig`, so the introspect layer
  stays pure and the MCP `GemTools.inventory` path (`src/gem.tools.ts:51`) is unaffected.
- New route `GET /api/artifact/content?id=…` → `{ id, content }`; `404` on unknown or
  unparseable id. Resolves through the same shared id helper, so mint and resolve cannot drift.
- `Cache-Control: no-cache` on both routes.

**On `no-cache`:** it means *revalidate every time*, not *do not cache*. Express already emits
a weak `ETag` and honors `If-None-Match` — verified: **`304`, 0 bytes, 40 ms**. The header
switches that on for the browser. `max-age` would be wrong: it would serve a stale artifact
list after the user installs a skill.

**Schema seam.** `InventorySchema` gets its own deferrable variants; the shared artifact
schemas are not loosened:

```ts
const DeferrableSkill = SkillArtifactSchema.extend({ id: z.string(), content: z.string().optional() });
// GemArtifactSchema keeps `content: z.string()` — guarded by a regression test
```

The client schema (`packages/console/src/api/routes.ts:10`) already declares
`content: z.string().optional()`, so the console tolerates a missing body today.

### Client

| Site | Change |
|---|---|
| `api/routes.ts` | `inventoryRoute` gains `body` query; new typed `artifactContentRoute` |
| `panels/Curate/index.tsx:134` | `Promise.all` inventory + usage (today: serial `await`, `await`); request `body=defer`; lazy-load body on expand, memoized by `id` |
| `panels/Setup/index.tsx:75` | request `body=defer`; lazy-load body when the artifact modal opens |
| `panels/Play/mcpHostTools.ts:56` | pass `body=defer` |

## Data flow

```
Curate mount
  └─ Promise.all([ inventoryRoute(body=defer), usageRoute(scope=global) ])   ~0.16 MB
       └─ render 413 rows from metadata + id

Row expand (id = workspace/skills/standalone/agentback)
  └─ memo hit?  → render
     memo miss? → artifactContentRoute({ id }) → { content } → memo.set(id, content)
```

## Error handling

- Unknown / unparseable `id` → `404` with a message naming the id. Not `500`.
- Body fetch fails → the row shows an inline error and stays expandable for retry. It does
  **not** blank the panel; a body is auxiliary to the list.
- `parseWorkspaceArtifactPath` returns `null` rather than throwing.
- An artifact present at list time but gone at expand time (uninstalled mid-session) → `404`,
  handled as above. Do not attempt to reconcile.

## Testing

- **`entityPath`** — round-trip every artifact shape: bare name, plugin source containing `:`
  and `@`, the instruction `codex:rules/default.rules` whose name contains `/`, and a
  source-less instruction. Malformed ids return `null`.
- **Server** — `body=defer` omits `content` but keeps `id`; `body=full` (and no flag) keeps
  both; `GET /api/artifact/content?id=` returns the body; unknown id → `404`; a source-less
  instruction is addressable.
- **Regression** — `GemArtifactSchema` still rejects an artifact missing `content`. This is
  the test that stops a future refactor from loosening the archive contract.
- **Client** — Curate expand fetches once then serves from memo; Setup modal lazy-loads;
  `mcpHostTools.getInventory` passes `defer`.
- **Not tested by CI:** payload size and the `304`. Verified by measurement (below), because
  asserting byte counts in a unit test tests the fixture, not the system.

## Verification

Measured against a real home (413 skills) on the built server, not asserted:

| | before | after (measured) |
|---|---|---|
| `GET /api/inventory` payload | 6,214,881 bytes | **166,872 bytes** — 37.2× smaller, 97.3% removed |
| `GET /api/artifact/content?id=` | — | `200`, 17.9 ms |
| unparseable id / unknown id | — | `404` / `404` |
| `Cache-Control` | absent | `no-cache` |
| revalidation (`If-None-Match`) | full payload re-sent | **`304`, 0 bytes** |
| Curate mount | serial (inventory → usage) | parallel (`Promise.all`) |
| bodies present under `defer` | all | **none** (verified: no `content` on any skill/instruction) |

The predicted shrink was 46×; the actual is **37.2×**, because the minted ids themselves
add ~33 KB. Recorded as measured, not as predicted.

Real-data encoding check: the instruction whose name contains a `/` addresses correctly as
`workspace/instructions/codex%3Arules%2Fdefault.rules`, confirming percent-encoded segments
are load-bearing rather than theoretical.

Root suite after the change: **2442 passed, 0 failed.**

## Amendments made during implementation

Recorded here so the spec matches what shipped. Each was forced by the code, not chosen.

1. **`id` is minted only on `skills`, `subagents`, `instructions`** — not "every artifact". `hook`
   and `mcp_server` have no `content`, so they have nothing to address, and those three are exactly
   the entity scheme's workspace collections. `id` is **required** on the wire for them: the server
   always mints it, and requiring it turns a mint regression into a loud test failure. (Response
   validation in `@agentback/rest` only logs at `debug` and still returns the payload, so this is a
   contract statement, not a runtime guard.)

2. **`defer` strips bodies from the GLOBAL lists only; `inventory.projects[]` is untouched.**
   `introspectAll` fills `projects[]` when `?projects=` is passed (Setup does this). The scheme's
   `workspace/*` addresses local, gem-less artifacts and has no project-scoped path. Rather than
   invent one, project artifacts keep inline `content` and get no `id`. `ProjectInventorySchema` is
   unchanged. Setup therefore has two live render paths, both tested.

3. **Curate's expand button gates on `detail || id`, not `detail`.** It previously rendered only
   `if (i.detail)`; under `defer` there is no `detail`, so the button would have vanished and no body
   could ever be loaded. The gate now means "has a body to load", not "has a body loaded".

Two defects found by review during implementation, both fixed and regression-tested:

- **Curate:** a recorded body-load error was never cleared on a later success, and the render checked
  the error before the body — so a transient failure permanently masked a successful retry.
- **Setup:** `<ArtifactViewer>` was unkeyed, so a hash-driven artifact switch
  (`#/setup/<tab>?a=<name>`, a documented cross-panel deep-link) re-rendered it in place and showed
  artifact A's body under artifact B's title. Fixed by keying on artifact identity so React remounts.

## Accepted costs

- **22 ms `introspectConfig` per body fetch.** Invisible for one expand. An N+1 only under an
  "expand 50 rows at once" pattern that does not exist. The fix — memoize the inventory on its
  digest — is easy to add when a caller needs it. Noted, not built.
- **~28 KB of ids** added to the payload. Rounding error against 5.81 MB of bodies removed.
- **`id` appears only on the inventory response**, not on `GemArtifact`. Two shapes for one
  artifact is a real wart; it is the price of not loosening the archive contract.
