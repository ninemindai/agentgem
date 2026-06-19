# agentgem — Harness Targets: materialize a Gem into a harness's on-disk layout (Design)

**Date:** 2026-06-17
**Status:** Approved design, pre-implementation
**Project:** `agentgem` (`/Users/rfeng/Projects/ninemind/agentgem`)
**Scope:** Make a Gem *portable across coding-agent harnesses* by adding **targets**. A target renders a normalized Gem into a specific harness's on-disk file layout via a pure `materialize(gem, target): { files, skipped }`. agentgem owns the rendering (pure functions, in-memory file tree); it writes nothing — the step-5 runner/operator writes the tree. This turns "the gem works on Claude *and* Codex" from an assertion into something the build tool can actually produce.

---

## 0. Motivation

agentgem already *ingests* from four harnesses (`~/.claude`, `~/.agents`, `~/.codex`, `~/.hermes`), normalizing their divergent formats into one artifact model tagged with a `source`. The inverse capability is missing: a Gem has no notion of which harness it is *for*, nor how to render its normalized artifacts back into that harness's layout. Without it, cross-agent portability (pressure-test assumption #2) is asserted, never produced. Materialization is also the concrete form of the step-5 runner's "install the gem into a clean agent" — the runner writes what `materialize` returns.

## 1. Design decisions (locked)

1. **A target's job is materialization** — render a Gem into a harness's on-disk layout. Compatibility is *derived* from what materialization can render (no separately-declared target list).
2. **agentgem owns a pure function → in-memory file tree** — `materialize(gem, target): MaterializeResult`. It writes nothing; the runner/operator writes the tree. Same discipline as checks (owns functions+types, runs nothing).
3. **Unmappable artifacts are skipped with a reason** — never silently dropped, never coerced. The result carries `skipped[]`.
4. **Four targets in v1**: `claude`, `codex`, `agents`, `hermes` — symmetric with the ingest side.
5. **Targets compose from shared convention renderers** — `AGENTS.md` is shared by codex+agents, `SKILL.md` by claude/codex/agents; a target references shared renderers rather than duplicating them.
6. **External fidelity over round-trip-with-`introspect`** — `introspect.ts` models Codex via `~/.codex/rules/*`, which is *wrong* for real Codex (which uses `AGENTS.md` + `config.toml`). Tests assert exact paths + format-valid content against the *real harness*, not a round-trip through our own (partly-incorrect) reader.
7. **Codex MCP renders as TOML** (`config.toml`, `[mcp_servers.<name>]`) via a purpose-built emitter — full Codex fidelity in v1.

## 2. Harness facts (verified)

- **Codex** reads instructions from `AGENTS.md` (precedence `AGENTS.override.md` → `AGENTS.md` → `TEAM_GUIDE.md` → `.agents.md`) and stores MCP in `~/.codex/config.toml` as `[mcp_servers.<name>]` TOML. (developers.openai.com/codex/guides/agents-md, /codex/config-reference, /codex/mcp)
- **agents.md** is a cross-harness open standard for `AGENTS.md`; it does **not** define an MCP location → the `agents` target skips MCP.
- **Claude** (per our own `introspect.ts`): skills `skills/<n>/SKILL.md`, MCP `.mcp.json`, hooks `settings.json` `.hooks`, instructions `CLAUDE.md`.
- **Hermes** (per `introspect.ts`): skills `DESCRIPTION.md`, persona `SOUL.md`; no MCP/hooks modeled.

## 3. Support matrix

| artifact | claude | codex | agents | hermes |
|----------|--------|-------|--------|--------|
| skill | `skills/<n>/SKILL.md` | `skills/<n>/SKILL.md` | `skills/<n>/SKILL.md` | `skills/<n>/DESCRIPTION.md` |
| instructions | `CLAUDE.md` | `AGENTS.md` | `AGENTS.md` | `SOUL.md` |
| mcp_server | `.mcp.json` | `config.toml` (TOML) | — skip (no standard MCP location) | — skip |
| hook | `settings.json` | — skip | — skip | — skip |

Skipped cells produce a `SkippedArtifact` with a human reason. The matrix is *data* (renderer references per type), so adding a cell later (e.g. `agents` MCP) is a one-line change.

## 4. Architecture — composable conventions (`src/gem/targets.ts`)

A target is a composition of per-artifact-type **convention renderers** (pure functions). Shared conventions are referenced by multiple targets so convergence is literal, not duplicated.

```ts
import type {
  Gem, PackArtifact, ArtifactType,
  SkillArtifact, McpServerArtifact, InstructionsArtifact, HookArtifact,
} from "./types.js";

export type TargetId = "claude" | "codex" | "agents" | "hermes";
export type FileTree = Record<string, string>; // relative path → file contents

export interface SkippedArtifact { artifact: string; type: ArtifactType; reason: string }
export interface MaterializeResult { files: FileTree; skipped: SkippedArtifact[] }

// A renderer turns the artifacts of ONE type into files. Skills render one-at-a-time;
// mcp/instructions/hooks are collected (one config / one concatenated file).
interface TargetSpec {
  id: TargetId;
  label: string;
  skill?: (a: SkillArtifact) => FileTree;
  mcp?: (servers: McpServerArtifact[]) => FileTree;
  instructions?: (all: InstructionsArtifact[]) => FileTree;
  hook?: (hooks: HookArtifact[]) => FileTree;
  // a per-type renderer being undefined === that type is unsupported (skipped) on this target
}
```

Shared renderers (illustrative, exact strings in the plan):

```ts
const skillSkillMd = (a: SkillArtifact): FileTree => ({ [`skills/${a.name}/SKILL.md`]: a.content });
const skillDescriptionMd = (a: SkillArtifact): FileTree => ({ [`skills/${a.name}/DESCRIPTION.md`]: a.content });

// Multiple instruction artifacts concatenate into the target's single canonical file,
// each under a "## <name>" separator so provenance survives.
const concatInstructions = (file: string) => (all: InstructionsArtifact[]): FileTree =>
  ({ [file]: all.map((i) => `## ${i.name}\n\n${i.content}`).join("\n\n---\n\n") });
const instructionsClaudeMd = concatInstructions("CLAUDE.md");
const instructionsAgentsMd = concatInstructions("AGENTS.md");
const instructionsSoulMd = concatInstructions("SOUL.md");

const mcpDotMcpJson = (servers: McpServerArtifact[]): FileTree =>
  ({ ".mcp.json": JSON.stringify({ mcpServers: Object.fromEntries(servers.map((s) => [s.name, s.config])) }, null, 2) });
const mcpCodexToml = (servers: McpServerArtifact[]): FileTree =>
  ({ "config.toml": tomlMcpServers(servers) }); // purpose-built emitter, §5

const hooksSettingsJson = (hooks: HookArtifact[]): FileTree =>
  ({ "settings.json": JSON.stringify({ hooks: hooksToEventMap(hooks) }, null, 2) });
```

Targets compose them:

```ts
export const TARGET_REGISTRY: Record<TargetId, TargetSpec> = {
  claude: { id: "claude", label: "Claude", skill: skillSkillMd,       instructions: instructionsClaudeMd, mcp: mcpDotMcpJson, hook: hooksSettingsJson },
  codex:  { id: "codex",  label: "Codex",  skill: skillSkillMd,       instructions: instructionsAgentsMd, mcp: mcpCodexToml },
  agents: { id: "agents", label: "Agents", skill: skillSkillMd,       instructions: instructionsAgentsMd },
  hermes: { id: "hermes", label: "Hermes", skill: skillDescriptionMd, instructions: instructionsSoulMd },
};
```

Entry points:

```ts
export function materialize(gem: Gem, target: TargetId): MaterializeResult;
export function compatibility(gem: Gem): Record<TargetId, { supported: number; skipped: number }>;
```

`materialize` groups `gem.artifacts` by type; for each group it calls the target's renderer (if present) and merges the returned files, else pushes every artifact in that group to `skipped[]` with a reason like `` `hooks unsupported on ${target}` ``. **Path collisions** (two same-named skills → same path) skip the *later* artifact with reason `` `path collision with an earlier ${type}` `` — never a silent overwrite. `compatibility` runs the same grouping across all four targets and returns per-target counts (the "works on Claude + Codex" badge).

### Trust boundary
Materialize *re-renders an already-redacted Gem*; it never re-secrets. MCP configs are emitted with their `<redacted>` values intact (both in `.mcp.json` and `config.toml`); the runner rebinds real values from `gem.requiredSecrets` at install. No materialized file may contain a secret value — asserted in tests.

## 5. The TOML emitter (purpose-built)

A minimal emitter for the known MCP-config shape only — **not** a general TOML library (YAGNI). It renders, for each server, a `[mcp_servers.<name>]` table with `command` (string), `args` (array of strings), and an `[mcp_servers.<name>.env]` sub-table of string values. Strings are double-quoted with `"`, `\`, newline, and tab escaped. Server names containing non-bareword characters are emitted as quoted keys (`[mcp_servers."weird name"]`). Values already redacted stay as their `<redacted>` string. Lives in `src/gem/targets.ts` (or a sibling `toml.ts` if it grows); covered by its own focused test.

## 6. Surface — one op + a thin UI

**Operation `materialize`** (one Zod contract → REST + MCP):

| Op | REST | MCP tool | Shape |
|----|------|----------|-------|
| `materialize` | `POST /api/materialize` | `materialize` | `{ selection, target, name?, dir?, projects? }` → `{ target, files, skipped, compatibility }` |

The handler resolves dirs, introspects, `buildPack`s, then returns `{ target, ...materialize(gem, target), compatibility: compatibility(gem) }`. One introspect yields both the chosen target's tree and the all-targets summary. Checks/`requiredSecrets` are unaffected (they live in the gem JSON, not the harness layout).

Schemas (`src/schemas.ts`): `TargetId` enum from `Object.keys(TARGET_REGISTRY)`; `MaterializeRequestSchema`, `MaterializeResponseSchema` (`{ target, files: record(string,string), skipped: SkippedArtifactSchema[], compatibility: record(TargetId,{supported,skipped}) }`).

**UI (`src/public/index.html`):** a target `<select>` (Claude/Codex/Agents/Hermes) and a new **"Materialize"** preview mode beside Summary/JSON. When active it `POST`s `/api/materialize`, lists rendered file **paths** (click-to-view via the existing content modal), shows a **"Skipped (N)"** banner with reasons, and a one-line **compatibility strip** (`claude ✓ · codex 2 skipped · agents 3 skipped · hermes 4 skipped`). It previews; it does not write to disk.

## 7. Module changes

- `src/gem/targets.ts` *(new)* — `TargetId`, `FileTree`, `SkippedArtifact`, `MaterializeResult`, `TargetSpec`, the shared convention renderers, `TARGET_REGISTRY`, `materialize`, `compatibility`, and the purpose-built TOML emitter (`tomlMcpServers`) + `hooksToEventMap` helper.
- `src/gem/types.ts` — re-export or define `ArtifactType` if not already exported (it is: `export type ArtifactType`). No Gem shape change.
- `src/schemas.ts` — `TargetIdSchema`, `SkippedArtifactSchema`, `MaterializeRequestSchema`, `MaterializeResponseSchema`.
- `src/gem.controller.ts` — `@post("/materialize", …)` method (MCP tool `materialize`).
- `src/public/index.html` — target selector + "Materialize" preview mode (paths list, skipped banner, compatibility strip).

## 8. Testing

Following the port-style unit + `@agentback/testing` controller + gstack page-smoke pattern:

- **`src/gem/__tests__/targets.test.ts` (unit, external fidelity):**
  - claude: skill → `skills/<n>/SKILL.md` (exact content); instructions concat → `CLAUDE.md`; mcp → `.mcp.json` that `JSON.parse`s to `{ mcpServers: { <n>: {…} } }` with `<redacted>` preserved; hooks → `settings.json` with a `.hooks` event map.
  - codex: skill → `SKILL.md`; instructions → `AGENTS.md`; mcp → `config.toml` containing `[mcp_servers.<n>]` + `command`/`args`/`[mcp_servers.<n>.env]`; hooks → **skipped** with reason.
  - agents: skill → `SKILL.md`; instructions → `AGENTS.md`; mcp → **skipped**; hooks → **skipped**.
  - hermes: skill → `skills/<n>/DESCRIPTION.md`; instructions → `SOUL.md`; mcp + hooks → **skipped**.
  - path collision: two same-named skills → second in `skipped[]` with collision reason; first wins.
  - secrets: no materialized file contains a secret value; `<redacted>` present where expected.
  - `compatibility(gem)` returns correct `{supported, skipped}` counts per target.
  - TOML emitter focus test: env sub-table, args array, key needing quoting, `"`/`\`/newline escaping.
- **Controller (`@agentback/testing`, temp fake `~/.claude`):** `POST /api/materialize {dir, selection, target:"codex"}` → `files` has `AGENTS.md` + `config.toml`; `skipped` lists the seeded hook; `compatibility` present; no secret value in the response.
- **Page (gstack at verify time):** load `/`, select a skill + an MCP server, choose target **Codex**, switch preview to **Materialize** → see `AGENTS.md` + `config.toml`, a "hooks skipped" note, and the compatibility strip.

## 9. Out of scope (named follow-ups)

- **Reconciling `introspect.ts`'s Codex reader** (`~/.codex/rules/*` → `AGENTS.md` + `config.toml` ingest) — a real ingest-side divergence, its own sub-project.
- **Writing the tree to disk / zip download in the browser** — the runner writes `FileTree`; agentgem returns it.
- **`agents`-target MCP**, Codex `developer_instructions` config form, AGENTS.md precedence variants (`AGENTS.override.md`, `.agents.md`), and a **per-target check matrix** (running a gem's checks once per target) — addable cells/ops later.
- **Secret rebinding / injection at install** — runner's job; materialize emits redacted configs + the gem declares `requiredSecrets`.

## 10. Platform fit

Targets make portability *producible*: a Gem built once renders into Claude, Codex, agents.md, and Hermes layouts, with an honest skip report and a derived compatibility badge. That badge and those file trees are what steps 5 (verify — install the tree into a clean agent) and 6 (publish — "runs on these harnesses") consume. agentgem's footprint stays small (one module + one op + one UI mode); everything that touches a real filesystem or a real agent remains the platform runner's.
