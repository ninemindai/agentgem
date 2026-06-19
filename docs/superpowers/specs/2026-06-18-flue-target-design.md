# agentgem — Flue Target: materialize a Gem into a Flue project (Design)

**Date:** 2026-06-18
**Status:** Approved design, pre-implementation
**Project:** `agentgem` (`/Users/rfeng/Projects/ninemind/agentgem`)
**Scope:** Add `flue` as a new `TARGET_REGISTRY` entry so `materialize(gem, "flue")` renders a Gem into a [Flue](https://flueframework.com) project (TypeScript agent framework by the Astro team, `@flue/runtime`). Flue is the first target that needs a **composed agent file** aggregating skills + instructions, so this also adds a small reusable `compose` hook to the target model. Once shipped, every workspace renders `.targets/flue/` for free.

---

## 0. Motivation

The platform's portability story names Flue alongside Eve/Codex/Claude. Eve proved the code-gen target pattern (TS project layout, MCP via generated connections, stdio→HTTP proxy bridge). Flue is the natural next target and a clean parallel — but it surfaces one model gap: Flue registers an agent through a single `agents/<name>.ts` file that *imports and lists* its skills and embeds its instructions, whereas the current `TARGET_REGISTRY` renders strictly per-artifact-type with no hook that sees the whole gem. Flue forces (and earns) a general `compose` hook, which the future OpenAI-SandboxAgent target will reuse.

## 1. Flue conventions (verified via /withastro/flue docs)

- **Agent file** `agents/<name>.ts` — default export `createAgent(() => ({ model, instructions, skills, tools }))` IS the registration; the **filename is the agent name**. An optional `export const route: AgentRouteHandler` guards HTTP exposure.
- **Skills** — `skills/<n>/SKILL.md`, **Agent-Skills-spec frontmatter** (`name` matching the directory, `description`), imported `import review from '../skills/review/SKILL.md' with { type: 'skill' }` and listed in `skills: [review, …]`. This is the *same* SKILL.md the `claude`/`codex` targets already emit.
- **Instructions** — a string passed as `instructions:` in `createAgent`.
- **MCP** — `connectMcpServer(name, { url, transport: 'streamable-http' | 'sse', headers })` returns tool definitions wired in via `init(agent, { tools })`. **Remote-only** (http/sse). No native stdio → needs a proxy bridge (reuse `mcpProxy.ts`, as Eve does).
- **Hooks** — no native concept.

## 2. Design decisions (locked)

1. **Reuse the SKILL.md renderer.** Flue skills use the identical `skills/<n>/SKILL.md` convention, so `flue` references the existing shared `skillSkillMd` renderer (convergence is literal, not duplicated).
2. **Add a `compose` hook to `TargetSpec`.** `compose?: (gem: Gem) => MaterializeResult`, run after the per-type renderers and merged with the same collision-checking. Flue uses it to emit `agents/<packname>.ts`. General + reusable (OpenAI-SandboxAgent will want it); Eve/Claude/Codex don't set it, so they're unchanged.
3. **Instructions fold into the agent file**, not a standalone file. Flue's `instructions` per-type renderer returns `{}` (a deliberate "handled by compose, no standalone file" marker, so instructions are NOT skip-reported), and `compose` reads instruction artifacts from the gem and embeds the concatenated text as the `instructions:` string.
4. **MCP mirrors Eve, remote-faithful.** `connections/<n>.ts` factory per server: http/sse → `connectMcpServer` with `url` + env-sourced auth headers; stdio → a generated `proxies/<n>.mjs` (reuse `stdioProxyRunner`) plus a connection at the localhost proxy URL. The async tool-wiring (`init(agent, { tools })`) is the operator's documented step — the same boundary Eve drew (user decision).
5. **Hooks unsupported → skipped** with a reason (like Eve).
6. **No `flue.config.ts` / `package.json` / `tools/` scaffold in v1.** We emit the *source layout* (agent + skills + connections + proxies), matching Eve's scope; the operator runs `npx flue init` for project config. Named out of scope.
7. **Secret-safe, redaction-faithful.** Auth reads `process.env["<NAME>"]` from `secretRefs` (names only); no secret value is ever emitted. Same trust boundary as Eve.

## 3. Support matrix (flue column)

| artifact | flue output |
|----------|-------------|
| skill | `skills/<n>/SKILL.md` (shared `skillSkillMd`) |
| instructions | folded into `agents/<packname>.ts` `instructions:` (no standalone file) |
| *(compose)* | `agents/<packname>.ts` — imports each skill, sets instructions, `skills: […]` |
| mcp_server (http/sse) | `connections/<n>.ts` → `connectMcpServer('<n>', { url, transport, headers })` |
| mcp_server (stdio) | `proxies/<n>.mjs` (proxy) + `connections/<n>.ts` at the localhost proxy URL |
| hook | — skip (no native concept) |

## 4. The `compose` hook (`src/gem/targets.ts`)

```ts
interface TargetSpec {
  id: TargetId;
  label: string;
  skill?: (a: SkillArtifact) => FileTree;
  mcp?: (servers: McpServerArtifact[]) => MaterializeResult;
  instructions?: (all: InstructionsArtifact[]) => FileTree;
  hook?: (hooks: HookArtifact[]) => FileTree;
  compose?: (gem: Gem) => MaterializeResult; // NEW: cross-cutting file(s) that see the whole gem
}
```

`materialize()` runs `compose` **after** the per-type renderers and merges its `files`/`skipped` with the existing collision-checking `merge`/`skipped` machinery (a `compose` path that collides with a per-type file is reported, never silently overwritten). `compose` is the only renderer that receives the whole `Gem`; it derives skill import paths with the shared `safePathSegment` so they match what `skillSkillMd` emitted.

## 5. Flue renderers (`src/gem/targets.ts`)

**`agents/<packname>.ts`** via `flueComposeAgent(gem)`:
```ts
import { createAgent, type AgentRouteHandler } from "@flue/runtime";
import skill0 from "../skills/<seg0>/SKILL.md" with { type: "skill" };
import skill1 from "../skills/<seg1>/SKILL.md" with { type: "skill" };

export const route: AgentRouteHandler = async (_c, next) => next();

const instructions = `<concatenated instruction artifacts, "## <name>" separated, template-escaped>`;

export default createAgent(() => ({
  model: "anthropic/claude-sonnet-4-6",
  instructions,
  skills: [skill0, skill1],
}));
```
- Agent filename = `safePathSegment(gem.name)`.
- Template-literal escaping for `instructions`: `\` → `\\`, `` ` `` → `` \` ``, `${` → `\${`.
- Empty skills → `skills: []`; empty instructions → `instructions: ""`.

**`connections/<n>.ts`** via `mcpFlueConnections(servers)` (parallels `mcpEveConnections`):
```ts
import { connectMcpServer } from "@flue/runtime";
export default () => connectMcpServer("<name>", {
  url: "<url-or-localhost-proxy>",
  transport: "streamable-http",            // "sse" when the server's transport is sse
  headers: { Authorization: process.env["<TOK>"]! },   // only when a headers.authorization secretRef exists
});
```
- http/sse with a real `url` → direct connection (auth/headers from `secretRefs`; a non-header secret → skip with reason).
- stdio with a `command` → `proxies/<n>.mjs` (reuse `stdioProxyRunner`, `PROXY_BASE_PORT`/`PROXY_HOST`) + a connection at `http://127.0.0.1:<port>/mcp`.
- otherwise → skip with a reason. Path collisions → skip the later one.

**Registry:**
```ts
flue: { id: "flue", label: "Flue", skill: skillSkillMd, instructions: () => ({}), mcp: mcpFlueConnections, compose: flueComposeAgent },
```

## 6. Surface — no schema change; one UI line

- **Schemas:** `TargetIdSchema` is `z.enum(Object.keys(TARGET_REGISTRY))`, so adding `flue` to the registry auto-extends the enum, the compatibility record, and the workspace `renderedTargets`. **No `schemas.ts` change.**
- **Workspace per-target tabs** read `compatibility` keys dynamically → `flue` appears automatically.
- **UI (`src/public/index.html`):** the Materialize-preview `<select id="target">` lists targets statically → add `<option value="flue">Flue</option>`. (One line.)

## 7. Module changes

- `src/gem/targets.ts` — `compose` on `TargetSpec`; `materialize()` runs+merges `compose`; `TargetId` gains `"flue"`; `flueComposeAgent`, `mcpFlueConnections`, and the `flue` registry entry. (Reuses `skillSkillMd`, `safePathSegment`, `stdioProxyRunner`, `PROXY_*`.)
- `src/public/index.html` — one `<option value="flue">Flue</option>`.

## 8. Testing

- **`src/gem/__tests__/targets.test.ts` (unit, external fidelity to Flue):**
  - `compose` mechanism: a target whose `compose` emits a file gets it merged; a `compose` path colliding with a per-type file is reported in `skipped` (not overwritten).
  - flue skill → `skills/<n>/SKILL.md` (exact content).
  - flue agent file → `agents/<packname>.ts` containing `createAgent`, an `import … with { type: "skill" }` per skill, the skill list, and the instructions string; instruction artifacts are NOT in `skipped`.
  - flue http MCP → `connections/<n>.ts` with `connectMcpServer`, the url, and `process.env["<TOK>"]` auth (no secret value); sse server → `transport: "sse"`.
  - flue stdio MCP → `proxies/<n>.mjs` + a `connections/<n>.ts` at `http://127.0.0.1:<port>/mcp`.
  - flue hook → **skipped** with reason.
  - instructions template escaping: a body containing a backtick and `${` is escaped so the generated file is valid TS.
  - `compatibility(gem)` includes a `flue` entry.
  - secret-safety: no flue file contains a secret value.
- **Page (gstack at verify time):** materialize-preview target **Flue** shows `agents/…` + `skills/…`; and in a workspace, the **flue** tab renders `.targets/flue/`.

## 9. Out of scope (named follow-ups)

- **Full async MCP wiring** (`run()` + `init(agent,{tools})` + `close()` in the agent file) — operator's step in v1; a deeper-wiring mode is a later option.
- **`flue.config.ts` / `package.json` / `tools/` scaffold** — operator runs `npx flue init`.
- **OpenAI-SandboxAgent target** — separate spec; will reuse the new `compose` hook.
- **Per-skill agent splitting** (one agent file per skill vs one aggregate agent) — v1 emits a single aggregate agent named after the gem.

## 10. Platform fit

Flue extends producible portability to a fourth code-gen surface with a small, faithful renderer set, and pays down a real model debt: the `compose` hook makes "one file that composes the whole gem" a first-class, reusable capability rather than a Flue special-case. Because `flue` is just a `TARGET_REGISTRY` entry, it lights up everywhere the registry is consumed — `materialize`, `compatibility`, and every workspace's `.targets/flue/` — with zero changes to the archive, workspaces, or schema layers.
