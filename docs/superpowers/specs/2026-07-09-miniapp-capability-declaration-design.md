# Miniapp capability declaration: intent, declaration, disclosure

**Date:** 2026-07-09
**Status:** approved, ready for planning

## The question

A miniapp that wants a live connection to a project or session must declare a
capability. Should the Studio offer checkboxes so the author can express that
requirement?

Yes — but only as *intent*. A checkbox cannot know what the agent will build, so
it must not be the thing that declares. This spec splits one field's ownership
three ways.

## What exists today

`MiniappMeta.needs?: GameCapability[]` (`packages/play/src/miniapps.ts`) is the
declaration. The union has four members (`packages/model/src/types.ts`):

| capability | host tool | consent |
| --- | --- | --- |
| `session-data` | `agentgem_get_session_data` | auto-approved (`AUTO_CAPS`) |
| `local-project-access` | `agentgem_get_inventory` | prompts the viewer |
| `live-session-events` | `agentgem_subscribe_sessions` | prompts the viewer |
| `invoke-agent` | `agentgem_invoke_agent` | prompts the viewer |

It is enforced in three places:

- the MCP host rejects a `callTool` for an undeclared capability with `-32601`;
- `assertPortable` (`packages/play/src/portability.ts`) blocks Save when a
  *content* capability is declared with no baked fallback. Only `session-data`
  is content; the other three are `enhancement` and never block publish;
- `CAP_TOOL` (`packages/console/src/panels/Play/mcpHostTools.ts`) maps each
  capability to exactly one tool name.

`needs` is written by the Studio agent, guided by prose in
`skills/agentgem-miniapp/SKILL.md`. **Nothing reconciles it against the code.**
There is no human input to it anywhere.

## Evidence: the drift is real, and it is one-directional

Deriving `needs` from the HTML of the ten miniapps in `~/.agentgem/miniapps` and
comparing against the declared value:

- 8 of 10 match exactly.
- 0 have `missing` (code calling an undeclared tool).
- 2 have `extra` (declared, never called): `live-watch` declares
  `live-session-events`, and `session-2de8e278-…` declares `session-data`.
  Neither file contains a single `agentgemApp` reference.

`live-watch` is an 1164-byte stub. Played today it asks a viewer to consent to
*"watch your live coding sessions in real time"* and then uses nothing.

**Mechanism.** `genres.ts` pre-declares `needs: ["session-data"]` on the `replay`
genre, and `seedStudio` writes it into `meta.json` before a line of code exists.
If the agent then builds something else, `needs` is stale forever.

## Why derivation is trustworthy here

`gameGate` bans `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`,
`importScripts` and `sendBeacon` outright. `window.agentgemApp` is therefore the
*only* channel a sealed miniapp has to the outside world, and a static scan for
literal tool names is total. There is no second channel a capability can hide in.
This would not hold for an ordinary web app.

## The asymmetry that drives the design

The two drift directions are not equivalent:

- **`missing`** — code calls an undeclared tool. *Widens* reach. Today: a runtime
  `-32601` with no explanation.
- **`extra`** — declares a tool it never calls. *Narrows* to nothing. Today: a
  gratuitous consent prompt.

Widening a permission must be a deliberate authored act. Narrowing is always safe
— it can never surprise a viewer. They get different treatment.

## Design

### Three owners

| concern | owner | artifact |
| --- | --- | --- |
| intent | the human | Composer checkboxes → seed prompt text. Never written to `meta.json`. |
| declaration | the code | `needs`, reconciled against the HTML at save |
| disclosure | the Studio | capabilities strip: derived `needs` + `CAP_LABEL` cost |

The checkbox proposes; the code disposes; the gate reports the difference. That
property is what makes an advisory checkbox safe: there is only ever one
authority over `needs`, so there is nothing to drift.

### 1. Declaration — reconciliation in `saveMiniapp`

Runs before `assertPortable`.

Derive by scanning `scannableCode(html)` for literal `agentgem_*` tool names.
Match the name **anywhere in executable code**, not only inside `callTool(...)`:
`scaffolds.ts` receives session data purely via `onNotification` comparing
`p.toolName === "agentgem_get_session_data"` and never calls. A `callTool`-only
scan would prune a capability the app genuinely receives.

- **`missing` → throw.** Failure string names the tool and the capability to add:
  `miniapp calls agentgem_subscribe_sessions but does not declare
  live-session-events — add it to meta.json "needs"`. This joins the existing
  failure-string idiom that `gameGate` calls "the self-repair loop's error
  signal", and surfaces through the gate banner already wired in `Studio.tsx`.
  It does not auto-add: auto-adding would silently widen a permission.
- **`extra` → prune, and say so.** Never silent. The pruned set appears in the
  save result, in the git commit message (`save miniapp live-watch (pruned unused
  capability: live-session-events)`), and in the Studio strip.

```ts
export interface SaveMiniappResult { name: string; commit: string | null; prunedNeeds: GameCapability[] }
```

Three ways this can go wrong, each of which the implementation must close:

1. The **pruned** meta is what gets persisted — `meta.json`, the commit, *and*
   `writeGameGem`. If `writeGameGem` sees the pre-prune meta, the shareable
   `game` gem keeps the phantom capability and the exercise leaks.
2. `checkpointMiniapp` reconciles **nothing**. It is the durability path; it must
   never fail and never rewrite meta, matching its contract ("a checkpoint must
   never fail on it").
3. `migrateAllMiniapps` calls `saveMiniapp` and inherits the prune. A symmetric
   equality check would make migration *throw* on exactly the two over-declared
   miniapps on disk.

   **Corrected during implementation.** Three claims above were wrong, and the
   migration needed real source changes, not just to inherit `saveMiniapp`:

   - `migrate.ts`'s codemod **injects** `callTool("agentgem_get_session_data")`
     into old html. A migrated bundle therefore *uses* a capability its stored
     meta never declared, and `saveMiniapp` rightly throws. The codemod authored
     the code, so it must author the declaration: it now passes
     `needs: deriveNeeds(html)`. This is safe **only** because the sole injected
     capability is `session-data`, which `AUTO_CAPS` marks auto-approved. A
     codemod injecting a consent-gated capability must not auto-declare it.
   - Migration only called `saveMiniapp` when it *rewrote* the html
     (`outcome === "migrated"`). On disk that is 1 of 10 miniapps — `live-watch`
     is `"unrecognized"`, so "one run cleans them" was false. The declaration can
     be stale even when the html is current, so migration now reconciles the meta
     of **every** miniapp, rewriting `meta.json` (and refreshing the gem) when
     `needs` drifted, without touching the html.
   - One unsaveable miniapp aborted the whole registry pass — `session-2de8e278-…`
     declares `session-data` but bakes no timeline, so `assertPortable` rejects it.
     That already failed on `origin/main`. Migration now records the reason on that
     row and continues.

**Prerequisite.** `CAP_TOOL` lives in `packages/console`, but `saveMiniapp` lives
in `packages/play`. Move the map to `@agentgem/model` beside the `GameCapability`
union, typed `Record<GameCapability, string>` — the compile-error-on-drift trick
`portability.ts` already uses for `CAP_CLASS`. Console imports it and deletes its
copy.

### 2. Intent — the Composer checkboxes

Exactly the three capabilities that cost the viewer something. `session-data` is
excluded: `AUTO_CAPS` marks it auto-approved ("declared at seed — implicit
consent") and the Session tab already implies it via `genres.ts`. Showing it
would ask the user to authorize what the source choice already decided.

Labels are `CAP_LABEL` from `consent.ts` verbatim — each box states what it
*costs*, not what it enables, in the same words the viewer's consent prompt uses:

```
This miniapp may:
  ☐ read your local setup — skills, MCP servers, and projects
  ☐ watch your live coding sessions in real time
  ☐ run a local AI agent on your machine
```

**Placement: above the tabs**, applying to every source. The motivating case — a
miniapp with a live connection to a project or session — is Project- or
Session-sourced, but only the Blank tab has a prompt box today. `seed()` composes
the same preamble and passes it as `seedPrompt`; `onCreated(name, seedPrompt?)`
already supports one.

Checking a box appends a line to the build prompt instructing the agent to use
the corresponding tool *and* declare the capability. Nothing else. If the agent
ignores the hint and writes no code, `extra` prunes it back out and says so.

### 3. Disclosure — the Studio strip

`Studio.tsx` already holds `meta` in state, posts it on save, and feeds
`meta?.needs` into `<Runner needs=…>`. So the strip renders `meta.needs` and
costs no new state. After a save returns `prunedNeeds`, `setMeta` drops them, the
strip updates, and `Runner`'s effect re-runs on the new `needs` and renegotiates.

The strip sits under the Studio title: one row per declared capability, labelled
with its `CAP_LABEL` cost. On a prune it shows a transient notice — *"removed
`live-session-events` — nothing in the miniapp uses it."*

### Data flow

```
Composer checkbox  ──(prompt text only)──▶  agent writes html + meta.needs
                                                       │
                                              saveMiniapp(html, meta)
                                                       │
                                     derive = scan(scannableCode(html))
                                          ┌────────────┴────────────┐
                                     missing → throw           extra → prune
                                          │                         │
                                          │              meta.json + commit msg
                                          │              + writeGameGem + result
                                          └──────────┬──────────────┘
                                                assertPortable
                                                     │
                                        Studio strip ◀── prunedNeeds
                                             │
                                        Runner needs=… ──▶ consent prompt (CAP_LABEL)
```

## Error handling

- **`missing`** → thrown failure string → the existing gate banner
  (`Studio.tsx`), which already offers to have the agent fix it.
- **Dynamic tool name** (`callTool(t)` where `t` is a variable) → the scan sees
  nothing → the capability would be pruned and the call would fail at play time
  with `-32601`. **Closed:** `saveMiniapp` rejects it via `hasDynamicToolCall`,
  turning a viewer-facing runtime failure into an actionable save-time error the
  agent self-repairs from. `SKILL.md` states the rule; the save now enforces it.

  The probe runs over a `codeSkeleton()` — comments removed, string bodies
  emptied — because `MINIAPP_BUILDER_BRIEF` states the rule using the very text
  `callTool(name)`, and an agent echoing it into a comment or a help string must
  not have its save blocked. That skeleton models neither regex literals nor
  `${}` interpolation, but every such error only *drops* text, and dropping text
  can only make the probe **miss** a dynamic call — never invent one. A miss is
  the pre-existing behaviour, so the failure direction is safe.

  The same skeleton must never narrow `deriveNeeds`: there a missed match prunes
  a capability the miniapp really uses, and the app breaks at `-32601`.
- **A tool name in a comment or an unrelated string literal** → the scan counts
  it, because it must match `p.toolName === "agentgem_get_session_data"` in an
  `onNotification` handler (`scaffolds.ts` receives data that way and never
  calls). So a bundle whose only mention of `agentgem_get_inventory` is a comment
  will *declare* `local-project-access`, and — being derived, not declared —
  it is not pruned. A viewer then sees a consent prompt for a tool the code never
  calls. This is the **safe error direction** (over-declare; never silently
  widen), it is visible in the Studio strip, and it is inherent to matching
  anywhere in executable code. Accepted, not fixed.
- **No host at all** → unchanged: the handshake gives up after ~4s and every
  `callTool` rejects with `"no host"`.

## Browser-bundle constraint (found during implementation)

`packages/console` is bundled for the browser by esbuild. `@agentgem/play`'s
barrel re-exports `miniapps.js` / `redact.js`, which import `node:os` /
`node:path` / `node:fs`. A **value** import of `CAP_TOOL` from `@agentgem/play`
therefore breaks `pnpm build` — while `tsc -b`, the console typecheck, and the
console vitest suite (Node environment) all still pass. Only the bundle catches
it, and CI runs the full build.

So `consent.ts` keeps a browser-safe mirror of `CAP_TOOL` / `TOOL_CAP`, and
`packages/console/src/panels/Play/__tests__/capTool.drift.test.ts` — which runs
in Node, where the import is free — asserts the mirror equals the canonical map.
A rename in `@agentgem/model` fails that test instead of drifting silently. The
console's every other `@agentgem/play` import is `import type`, which is erased.

## Testing

Derivation is a pure function over a string.

- A tool name inside a `<script type="application/json">` blob must **not** count
  (`scannableCode`'s purpose; `gameGate` has fixtures).
- An `onNotification` `toolName ===` comparison with no `callTool` **must** count,
  or `scaffolds.ts` regresses.
- `missing` throws and names the capability.
- `extra` prunes and appears in `prunedNeeds`.
- `writeGameGem` receives the pruned set, not the authored one.
- Integration: `migrateAllMiniapps` cleans an over-declared miniapp rather than
  throwing.
- Composer: a checked box reaches `onCreated`'s `seedPrompt`; an unchecked one
  does not; no code path writes `needs` from a checkbox.

## Build-order constraint

`PlaySaveResponseSchema` is duplicated — `src/schemas.ts` (server) and
`packages/console/src/api/routes.ts` (client). Both must grow `prunedNeeds`
together or the client silently drops the field.

## Out of scope (deliberate)

- **No per-capability toggle in the strip.** The code decides. A toggle would
  reintroduce the second authority this design removes.
- **No `needs` editor UI.** `meta.json` belongs to the agent; the strip shows the
  truth.
- **No deletion of the `needs` field.** Deriving-and-discarding would ripple into
  `GameArtifact`, the marketplace, and the migration path for no gain over
  reconciliation.

## Accepted trade-off

An author can no longer deliberately under-declare — ship code that calls
`agentgem_get_inventory` while omitting it from `needs`, so the call fails and
the game falls back to baked data on purpose. That is representable today
(`SKILL.md` tells authors to handle `-32601`). It becomes a save-time error. This
is a confusing way to express "optional enhancement" and the baked fallback
already covers the case.
