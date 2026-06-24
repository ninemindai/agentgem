# Workflow-Aware Gem Recommendation — Design

**Date:** 2026-06-24
**Branch:** `feat/workflow-aware-gem-reco`
**Status:** Design approved, ready for implementation plan

## Problem

agentgem today reads *config* (what is installed in a `.claude/`/`.codex/`
project) via `introspectProject`, but never reads *behavior* (what a workflow
actually exercised). The session transcripts under `~/.claude/projects/` and
`~/.codex/sessions/` are already opened by `discoverProjects` — but only to
regex out `cwd` for the recents list. Their content (which skills / MCP servers
/ hooks actually fired, how often, together) is untapped signal.

This feature joins the two: read a project's transcripts to learn what its
recurring workflow *uses*, then recommend a Gem composition — a pre-checked
selection in the existing `buildGem` flow, with a proposed name, description,
and per-item rationale.

## Decisions (from brainstorming)

- **Analysis engine:** deterministic extraction **+** a local ACP coding agent.
  The deterministic scan produces the hard, reproducible signal; the ACP agent
  (lifted from agentback `console-chat`) clusters / names / explains.
- **Input scope:** all sessions in **one project** (one `cwd` / one row in the
  testbed on-ramp Discovered/Recents list).
- **Output:** a **pre-checked selection + rationale** that lands in the existing
  introspect→select→buildGem pipeline. Not an advisory-only report; not a
  fully-auto Gem. Human reviews the checkboxes, then proceeds normally.
- **Scan breadth:** read **all** sessions, **cap bytes-per-file** (reuse the
  existing bounded head-read), and **keep `invocations:0`** artifacts in the
  signal (installed-but-unused is itself a useful "do not bundle" signal).

## Architecture & data flow

A new pipeline stage between *discover* and *introspect/select*. Entry point is
the existing per-project row in the testbed on-ramp; a new **"Analyze workflow"**
action triggers:

```
project row (cwd)
   │
   ├─1─ introspectProject(root)          existing: WHAT is installed (inventory)
   │
   ├─2─ scanWorkflow(transcripts, inv)   NEW deterministic: WHAT actually fired
   │        reads ~/.claude|.codex sessions for this cwd, emits a WorkflowSignal
   │        (per-inventory-name usage counts, co-occurrence, session span)
   │
   ├─3─ AcpRecommender(signal, inv)      NEW: port console-chat's AcpSession
   │        grounds a local coding agent with signal+inventory, prompts for a
   │        structured GemRecommendation, streams progress to UI over SSE
   │
   └─4─ recommendation → pre-checked selection + name/description + rationale
            lands in the existing buildGem selection UI for review → normal flow
```

New modules: `src/gem/workflowScan.ts` (deterministic, pure, fully testable) and
`src/gem/acpRecommender.ts` (ACP harness ported from `console-chat`, with its
`connectFn` seam). New endpoint `POST /api/workflow/analyze` plus an SSE stream
for agent progress. New UI affordance on the project row.

**The deterministic scan is the trust boundary.** It produces a typed
`WorkflowSignal` the agent consumes, so the agent never parses raw `.jsonl` and
the signal is independently unit-testable. Everything downstream only
ranks / explains / renders what the scan produced.

## Grounding findings (verified against real transcripts)

- **Availability ≠ usage.** The `mcp__…` tool names appear in *every* session's
  system-prompt catalog whether used or not (observed ~12× echoes). Only parsed
  `type:"tool_use"` blocks in **assistant** messages are real invocations. The
  scanner MUST parse JSON, not string-match, or it overcounts MCP by ~10×. This
  gets an explicit regression test.
- **Names need normalizing.** Transcripts encode
  `mcp__plugin_context7_context7__resolve-library-id`; the inventory key is
  `context7`. Skills carry their full id in `Skill.input.skill`
  (`superpowers:brainstorming`). Mapping back to inventory names is a real
  (mostly mechanical, sometimes fuzzy) step.
- **Hooks barely show up.** Hooks are not `tool_use`; they surface only as
  injected `…hook success:` / `<system-reminder>` text. Weakest deterministic
  signal → `confidence:"low"`, leaned on the agent to interpret.

## `WorkflowSignal` shape

Produced by `scanWorkflow(transcriptPaths, inventory)` — pure, deterministic,
unit-testable. Usage is already mapped onto inventory names so both the
recommender and the fallback path bind directly to a selection.

```ts
export interface WorkflowSignal {
  root: string;                    // project cwd analyzed
  flavor: "claude" | "codex";      // hermes keeps no per-repo transcripts → empty signal
  sessions: { scanned: number; firstMs: number; lastMs: number; spanDays: number };

  // One entry per inventory artifact, keyed to its inventory name so it binds
  // straight to a selection. usage=0 means "installed but never fired".
  artifacts: ArtifactUsage[];

  // tool_use names seen in transcripts that did NOT resolve to any inventory
  // artifact (e.g. an MCP server used but since removed, or a built-in). The
  // agent reads these as "workflow needs something the inventory doesn't have".
  unresolved: { name: string; kind: ArtifactType | "builtin"; count: number }[];

  // Which artifacts fired together within the same session — drives clustering.
  // Sparse upper triangle.
  coOccurrence: { a: string; b: string; sessions: number }[];

  notes: string[];                 // scanner caveats, e.g. "hook signal is low-confidence"
}

export interface ArtifactUsage {
  type: ArtifactType;              // skill | mcp_server | instructions | hook
  name: string;                    // EXACT inventory name (introspectProject key)
  invocations: number;             // parsed tool_use count (0 = installed, unused)
  sessionsUsedIn: number;          // distinct sessions it fired in (breadth)
  lastUsedMs: number | null;       // recency
  confidence: "high" | "low";      // skills/mcp = high; hooks/instructions = low
  evidence?: string;               // tiny excerpt, e.g. "Skill(qa)" — for rationale display
}
```

Resolution rules baked into the scanner:

- **MCP** — a `tool_use` whose `name` starts with `mcp__`; strip the
  `mcp__…__tool` wrapper to a server token, fuzzy-match to `mcpServers[].name`
  (substring / normalized). Unmatched → `unresolved`.
- **Skill** — `tool_use name:"Skill"`, read `input.skill`; match to
  `skills[].name`.
- **Hook** — scan injected `…hook success:` / system-reminder lines for the
  hook's `command` basename or `event`; `confidence:"low"`, `invocations`
  approximate.
- **Instructions** — presence-only (loaded every session, never "invoked");
  `invocations` = sessions scanned, `confidence:"low"`.

`invocations:0` is kept (not dropped) — "installed but never used" tells the
recommender *not* to bundle something, and the UI can grey it.

## ACP recommender & grounding

`acpRecommender.ts` ports `console-chat`'s `AcpSession` (the `connectFn` seam
comes with it → tests inject an in-process fake agent, no binary in CI). One
short, bounded session:

```
AcpRecommender.recommend(signal, inventory) → GemRecommendation
  1. connect()            spawn local agent (claude|codex) over ACP stdio
  2. open(cwd=root)       NO mcpServers, plan/read-only permission mode —
                          this agent only reasons over text we hand it
  3. inject grounding     signal + inventory (skill DESCRIPTIONS, not bodies),
                          serialized compact JSON, strict "return ONLY JSON
                          GemRecommendation" instruction
  4. drain one turn       parse JSON from final message; stream status over SSE
  5. dispose()            kill subprocess
```

The agent's job is narrow: cluster high-usage artifacts into a coherent Gem,
name + describe it, justify each pick — using `coOccurrence` to group and
`unresolved` to flag gaps. It is told the usage numbers are authoritative and
not to invent artifacts outside the inventory.

```ts
export interface GemRecommendation {
  name: string;                 // proposed Gem name
  description: string;          // one-paragraph "what this workflow does"
  include: RecommendedItem[];   // → pre-checked selection
  exclude: RecommendedItem[];   // installed-but-not-recommended (shown greyed, why)
  gaps: string[];               // from `unresolved` — "uses X, not in inventory"
  confidence: "high" | "medium" | "low";
}
export interface RecommendedItem {
  type: ArtifactType;
  name: string;                 // EXACT inventory name → maps to a checkbox
  reason: string;               // short rationale shown inline
}
```

**Critical contract:** the agent returns only inventory `name`s. On parse, the
recommender **validates every `include[].name` against the inventory and drops
any hallucinated entry** (logged, not trusted) before it becomes a selection —
the deterministic inventory is the source of truth; the agent only ranks /
clusters / explains. This mirrors agentgem's `redact` discipline: never give
the soft layer authority over what is real.

**Graceful degradation.** If the agent is unavailable or returns junk, fall back
to the **deterministic default**: include everything with
`invocations > 0 && confidence:"high"`, no name/description. The response carries
`degraded:true` so the UI can say "recommended from usage frequency; agent
unavailable."

Safety: `plan` permission mode + empty `mcpServers` — the recommender agent
never edits files or calls tools; it reasons over the JSON brief only.

## Error handling & testing boundaries

**`workflowScan.ts` — pure, total, never throws.**
- Input: transcript paths + `ProjectInventory`. Output: `WorkflowSignal`. No I/O
  beyond bounded head-reads (reuse the byte-cap machinery in `testbedFlavors.ts`).
- Malformed `.jsonl` line → skipped, counted in `notes`. Corrupt/empty session
  contributes nothing rather than failing — same forgiving posture as
  `discoverProjects` (malformed → `[]`).
- Empty result (no transcripts, or Hermes flavor) → valid `WorkflowSignal` with
  `sessions.scanned:0` and every artifact `invocations:0`. Downstream treats as
  "no behavioral signal, fall back to inventory."
- **Tests** (pure fixtures): fixed `.jsonl` → exact `ArtifactUsage` counts;
  availability-vs-usage regression (catalog `mcp__…` lines yield `invocations:0`);
  name-normalization table; co-occurrence pairing; malformed-line; empty-scan.

**`acpRecommender.ts` — bounded, always resolves to a `GemRecommendation`.**
- `connectFn` seam → tests inject in-process fake agent returning canned JSON;
  no real binary in CI.
- Four failure modes, all → deterministic fallback (never a 500): agent binary
  absent (doctor probe); spawn/handshake error; turn timeout (hard cap ~60s,
  `dispose()` kills subprocess); unparseable/non-JSON final message.
- **Hallucination guard is a test:** fake-agent response with an inventory-absent
  `include[].name` → assert dropped from selection and logged.
- **Safety asserted:** `plan` mode + empty `mcpServers` asserted in a test so a
  future change can't silently let this agent touch files.

**Endpoint / controller — degrade, don't fail.**
- `POST /api/workflow/analyze` orchestrates scan → recommend; SSE streams agent
  status. On fallback the response still carries a valid pre-checked selection
  plus `degraded:true`.
- Controller test drives the whole path with the fake agent and asserts the
  landed selection matches the recommendation's validated `include[]`.

**Seams that keep this testable** (each mirrors an existing repo pattern):

| Seam | Injected in tests | Existing precedent |
|---|---|---|
| transcript paths | fixture files | `discoverProjects(dirs)` takes `DiscoveryDirs` |
| `connectFn` | in-process fake agent | lifted from `console-chat` |
| inventory | hand-built `ProjectInventory` | pure return of `introspectProject` |

## Out of scope (YAGNI)

- Single-session and cross-project analysis (per-project only for v1).
- Fully-auto Gem build (human review checkpoint stays).
- Hermes transcript analysis (no per-repo session history; returns empty signal).
- Streaming the agent's reasoning tokens to the UI beyond coarse status lines.

## New dependency

`@agentclientprotocol/sdk` (`^0.28`, the version agentback `console-chat` uses) —
added to agentgem for the recommender harness.

---

## Revisions after design review (2026-06-24)

An independent review against the real agentgem + agentback code found four
load-bearing issues. These corrections supersede the relevant claims above and
are the assumptions the implementation plan is built on.

**R1 — Selection is project-namespaced, not a flat name list. (was: MAJOR)**
`GemSelection` (`buildGem.ts:12-21`) keys project artifacts under
`projects: Record<projectRoot, ProjectSelection>`, a namespace separate from the
global top-level arrays. Because v1 scope is exactly one project, the
recommendation binds to `{ projects: { [root]: ProjectSelection } }` and the
inventory passed to `buildGem` is `introspectAll(dir, [root])` (the controller's
existing merge of global + project inventories, `gem.controller.ts:384-388`).
- `ArtifactUsage` and `RecommendedItem` carry the **project root** they belong to
  (always the single analyzed root in v1, but explicit and future-proof).
- **Instructions are not a named checkbox** — `ProjectSelection.includeInstructions`
  is a boolean (`buildGem.ts:8`). So the recommendation exposes a per-project
  `includeInstructions: boolean`, NOT an `instructions` entry in `include[]`. The
  `ArtifactUsage{type:"instructions"}` entry is display-only and drives that flag.
- **Hook names are the mangled inventory names** (e.g. `PreToolUse · Bash`,
  `introspect.ts` hook naming). The scanner's hook resolver must emit the EXACT
  inventory name, matched by event + command basename.

**R2 — Scanner reads FULL transcript files; the head-read byte-cap is dropped.
(was: BLOCKER)** The `readHead` machinery in `testbedFlavors.ts:202-218` reads
only the first 64 KB (it exists solely to grab `cwd` near the top). `tool_use`
blocks are scattered through the whole file, so a front-cap would systematically
undercount. The scanner instead **streams each `.jsonl` line-by-line over the
full file**, JSON-parsing each line. The only bound is a generous per-file
**max-lines safety guard** (runaway protection, e.g. 100k lines → note + stop),
NOT a byte cap. This revises the "reuse the byte-cap machinery" and "no I/O
beyond bounded head-reads" claims: the scanner does full-file line I/O, still
pure-of-side-effects and unit-testable via fixture paths.

**R3 — No SSE in agentgem; v1 returns a single JSON response. (was: BLOCKER)**
agentgem has no streaming primitive — every route is a decorator (`@post`) over
`@agentback/openapi` returning one Zod-validated JSON body (`gem.controller.ts`).
v1 therefore drops SSE: `POST /api/workflow/analyze` is a normal decorator route
that runs scan → recommend synchronously (bounded by the recommender's ~60s hard
cap) and returns one `WorkflowAnalyzeResponse` JSON:
`{ recommendation, selection: GemSelection, signalSummary, degraded }`.
The UI shows a spinner, then renders the pre-checked selection. Progress
streaming (SSE on the raw `expressApp`) is an explicit **deferred follow-up**, not
v1. This removes the "SSE stream for agent progress" from scope.

**R4 — Claude flavor only for v1; codex deferred. (was: MAJOR)** Codex sessions
use a different envelope (date-partitioned rollout files, `{"type":"session_meta",
"payload":{cwd}}`, no `Skill` tool, no `mcp__plugin_…` naming —
`testbedFlavors.ts:115-116, 296-309`). The Claude resolution rules above do not
transfer. v1 implements the **Claude** scanner only; a codex cwd yields an empty
signal + a note, and codex transcript analysis joins Hermes in "out of scope
(follow-up)." `WorkflowSignal.flavor` stays in the type for forward-compat.

**R5 — New cwd→transcript-paths resolver (no existing helper).** `discoverProjects`
returns only the newest session per folder (for `cwd`), and the Claude folder-name
encoding is lossy (`testbedFlavors.ts:99`). The scanner needs a new
`claudeTranscriptsForCwd(dirs, cwd)` that scans **all** `~/.claude/projects/*`
folders, parses each session's real `cwd`, and returns **every** matching
`.jsonl` path. This is the "transcript paths" seam — a hand-built path list in
tests.

**R6 — ACP port: internal deps to replace.** Porting `acp-session.ts` drops/replaces:
`@agentback/common` `loggers` → agentgem's existing logging (plain `console.*`,
matching the repo); `buildAugmentedPath` (pnpm-workspace `node_modules/.bin` walk,
wrong for agentgem) → a minimal PATH (inherit `process.env.PATH`, optionally
prepend agentgem's own `node_modules/.bin`); `AgentDescriptor` → a local minimal
type (`{ id; name; command: string[] }`). `permissionMode:'plan'` and the empty
`mcpServers` array must be passed **explicitly** — `open()` defaults to
`'default'`, not `'plan'`.
