# Eve runnable project + local/Vercel deploy

**Date:** 2026-06-19
**Status:** Approved (design)

## Goal

Make a gem **deployable to Eve** end-to-end: agentgem should render a *runnable*
vercel/eve project from a gem and let the operator run it locally or deploy it to
Vercel from the UI. A validation spike (see Background) surfaced a prerequisite
renderer bug, so the work is phased.

## Background — spike findings (vercel/eve v0.11.7)

A spike scaffolded a real eve project (`npx eve init`), overlaid the gem's
rendered `agent/` output, and ran `eve info`:

- **Layout is correct.** eve recognized `agent/skills/`, `agent/connections/`,
  `instructions.md` (nested layout).
- **Connections are correct.** All 6 MCP connections compiled clean —
  `eveConnection` already matches `defineMcpClientConnection` from
  `eve/connections`.
- **Skills are broken.** `skillEveMd` emits each source `SKILL.md` verbatim, but
  eve's authored-skill frontmatter schema allows only `description`, `metadata`
  (string→string map), and `license`. **118 of 199 skills were rejected**
  (unknown keys like `preamble-tier`/`allowed-tools`/`triggers`; non-string
  `metadata.priority`). 81 survived.
- **`proxies/` is unsupported.** eve ignores it; eve connections are URL-only, so
  the stdio-MCP→localhost-proxy bridge has no eve equivalent.
- **Runnable project is missing.** agentgem emits source only. eve needs
  `agent/agent.ts`, `agent/channels/eve.ts`, `package.json` (`engines.node:
  24.x`, deps `eve`/`ai`/`zod`/`@vercel/connect`), `tsconfig.json` — which
  `eve init` provides.
- **Deploy commands:** local = `eve build && eve start` (non-interactive;
  `eve dev` is the interactive TUI, unsuitable for automation). Vercel =
  `eve build` with `VERCEL=1` (writes `.vercel/output`) then `vercel deploy`.

A verification harness exists at `/tmp/eve-spike` (a real eve project) for
checking renderer changes with `eve info`.

## Decisions

- **agent.ts model:** `anthropic/claude-sonnet-4.6` (eve's scaffold default).
- **Local run:** agentgem runs `eve build && eve start` as a managed subprocess
  and surfaces the URL + logs.
- **Vercel auth:** a `VERCEL_TOKEN` read from server env (`.env`), mirroring how
  `ANTHROPIC_API_KEY` gates `claude-managed`.

---

## Phase 1 — Fix the eve skill renderer

**File:** `src/gem/targets.ts` (`skillEveMd`), test `src/gem/__tests__/targets.test.ts`.

`SkillArtifact` carries `name`, `description?`, and `content` (the raw `SKILL.md`,
frontmatter included). Replace verbatim emission with frontmatter normalization:

1. Strip a leading YAML frontmatter block (`^---\n … \n---\n`) from `content`,
   keeping the body.
2. Re-emit eve-valid frontmatter: if `description` is present, prepend
   `---\ndescription: <scalar>\n---\n` where `<scalar>` is a safe double-quoted
   YAML string (use `JSON.stringify(description)` — valid YAML flow scalar). If
   `description` is empty/absent, emit the body with **no** frontmatter (eve
   derives the routing hint from the first body line).
3. Path unchanged: `agent/skills/${safePathSegment(name)}.md`.

Do **not** carry `metadata`/`license` (not modeled on `SkillArtifact`) — dropping
them is correct; `description` is the routing hint eve needs.

**Helper:** a small `stripYamlFrontmatter(content: string): string` (regex on a
leading `---` block) co-located in `targets.ts`.

**Verification:**
- Unit: a skill whose source has `preamble-tier`, `allowed-tools`, and numeric
  `metadata.priority` renders to a body preceded only by `description:` (or no
  frontmatter when description is absent); the body is byte-identical post-strip.
- Harness: re-render the gem, copy `agent/skills/` into `/tmp/eve-spike/agent/`,
  `npx eve info` → 199 skills, 0 `skill-frontmatter-invalid` diagnostics.

---

## Phase 2 — Emit a runnable eve project

**File:** `src/gem/targets.ts` — add a `compose` hook to the `eve` `TargetSpec`
(same mechanism as `flue`/`openai-sandbox`), plus eve mcp-renderer change.

**Reverses** the prior "no scaffold in v1" scope decision (documented in the
flue/openai-sandbox specs) **for eve specifically.**

`compose(gem)` emits, from templates pinned to eve 0.11.x (captured from
`eve init`):

- `package.json` — `engines.node: "24.x"`; deps `eve ^0.11.7`, `ai 7.0.0-beta.178`,
  `zod 4.4.3`, `@vercel/connect 0.2.2`; scripts `build: eve build`, `dev: eve dev`,
  `start: eve start`, `typecheck: tsgo`. `name` from `gem.name`.
- `tsconfig.json` — eve's scaffold tsconfig verbatim.
- `agent/agent.ts` — `import { defineAgent } from "eve"; export default
  defineAgent({ model: "anthropic/claude-sonnet-4.6" });`
- `agent/channels/eve.ts` — eve's standard HTTP channel (verbatim from scaffold).
- `.gitignore`, `.vercelignore` — from scaffold.

**stdio MCP → skipped for eve.** eve connections are URL-only. Change
`mcpEveConnections` so stdio servers are added to `skipped` (reason: "eve
connections require an HTTP/SSE URL; stdio MCP unsupported") instead of emitting a
`proxies/` runner + localhost connection. Only `http`/`sse` servers become
`agent/connections/*.ts`. Drop `proxies/` emission for eve entirely.

**Verification:**
- Unit: eve render of a gem with one http and one stdio MCP server emits one
  connection file and one `skipped` entry; emits `package.json` (node 24),
  `agent/agent.ts` (sonnet-4.6), `agent/channels/eve.ts`.
- Harness/manual: render full gem to a fresh dir → `npm install` → `eve build`
  succeeds → `eve start` serves the session routes.

---

## Phase 3 — Deploy orchestration + UI (own sub-spec)

Largest phase; this section is the architecture, to be detailed in its own
spec → plan before implementation.

**Module:** `src/gem/run.ts` — operations over a workspace's `.targets/eve/`:

- `readiness()` → `{ local: node>=24, vercel: !!process.env.VERCEL_TOKEN }`.
- `startLocal(name)` — `npm install` (once), then spawn `eve build && eve start`
  as a managed child process; capture stdout/stderr; parse the served URL; track
  in an in-memory process registry keyed by workspace name.
- `stopLocal(name)` — terminate the tracked process.
- `deployVercel(name)` — spawn `eve build` with `VERCEL=1` + provider keys in env,
  then `vercel deploy --yes --token $VERCEL_TOKEN`; return the deployment URL
  parsed from stdout. Throws if `VERCEL_TOKEN` unset.

**Controller endpoints** (`src/gem.controller.ts`):
- `GET  /api/run-ready?name=&target=eve` → readiness booleans.
- `POST /api/run` `{ name, target: "eve", mode: "local" | "vercel" }` →
  `{ url, mode }`.
- `POST /api/run/stop` `{ name }` → `{ stopped }`.

**UI** (`src/public/index.html`): on the eve target view, a "Run" section with
"Run locally" / "Deploy to Vercel" buttons, readiness-gated like `publish-ready`,
showing status, the URL, and tailing logs.

**Security:** spawning installs/processes is a real surface — restrict to the
local server on the operator's machine; never expose run endpoints to untrusted
callers; the Vercel token stays server-side (never returned).

**Open for the Phase 3 sub-spec:** log streaming transport (poll vs SSE);
process lifecycle across server restarts; concurrent runs; `vercel` CLI provenance
(bundled dep vs `npx vercel`).

---

## Testing / verification

- Existing vitest suite stays green (clean build: `rm -rf dist *.tsbuildinfo &&
  pnpm test`; vitest runs compiled tests from `dist/`).
- Phase 1 & 2 add unit tests in `targets.test.ts`.
- End-to-end truth source is the eve toolchain itself (`eve info` / `eve build`)
  against rendered output, via the `/tmp/eve-spike` harness.

## Out of scope

- stdio MCP execution on eve (no eve equivalent; marked `skipped`).
- Changing flue / openai-sandbox scaffold scope (eve only).
- A general multi-target "run" surface — Phase 3 is eve-specific; generalize later
  if a second runnable target appears.
