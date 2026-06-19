# agentgem — OpenAI SandboxAgent Target: materialize a Gem into an OpenAI Agents SDK project (Design)

**Date:** 2026-06-18
**Status:** Approved design, pre-implementation
**Project:** `agentgem` (`/Users/rfeng/Projects/ninemind/agentgem`)
**Scope:** Add `openai-sandbox` as a `TARGET_REGISTRY` entry so `materialize(gem, "openai-sandbox")` renders a Gem into an [OpenAI Agents SDK](https://github.com/openai/openai-agents-js) **SandboxAgent** project (`@openai/agents`). Distinct from the existing `codex` target (Codex CLI: `AGENTS.md` + `config.toml`); this is the code-defined SDK shape. Reuses the `compose` hook shipped with Flue — no `TargetSpec` model change. Once shipped, every workspace renders `.targets/openai-sandbox/` for free.

---

## 0. Motivation

The platform's portability matrix names the OpenAI Agents SDK SandboxAgent as a distinct deploy surface from Codex CLI. Flue proved the code-gen pattern and added the reusable `compose(gem)` hook; SandboxAgent is the same "one file composes the whole gem" shape, so it lands cheaply on that hook. It also exercises two things Flue couldn't: **native stdio MCP** (no proxy bridge) and a **Manifest** that seeds the workspace — confirming the target model generalizes across genuinely different harnesses.

## 1. OpenAI Agents SDK conventions (verified via /openai/openai-agents-js + developers.openai.com)

- **Imports:** `import { SandboxAgent, Manifest, localDir, shell, filesystem, skills } from "@openai/agents/sandbox";` and `import { MCPServerStreamableHttp, MCPServerStdio } from "@openai/agents";`.
- **Agent:** `new SandboxAgent({ name, model, instructions, defaultManifest, capabilities, mcpServers, tools?, handoffs? })`. `SandboxAgent extends Agent`, so it keeps `instructions`, `mcpServers`, `tools`, etc., plus sandbox defaults (`defaultManifest`, `capabilities`).
- **Manifest:** `new Manifest({ entries: { "<path>": <entry> }, environment? })`. Entry helpers: `file({content})` (inline), `localFile()`/`localDir()` (materialize host files into the sandbox — `localDir({ from, readOnly })`), `gitRepo()`, mounts. Docs: *"Prefer `readOnly: true` for input bundles such as shared skills."*
- **Capabilities:** `[shell(), filesystem(), skills(), memory(), …]`.
- **MCP (native, both transports):** remote → `new MCPServerStreamableHttp({ url, name, requestInit?, authProvider? })` (auth via `requestInit: { headers: { Authorization } }`); local stdio → `new MCPServerStdio({ command, args, env?, name })`. **No proxy bridge needed.**
- **Run (operator step, not generated):** `await run(agent, prompt, { sandbox: { client: new UnixLocalSandboxClient() } })`.
- **Model literal:** `"gpt-5.5"` (the SDK's sandbox examples).
- **Hooks:** no native concept.

## 2. Design decisions (locked)

1. **Reuse the `compose` hook + `skillSkillMd`.** `openai-sandbox` sets `skill: skillSkillMd` (skill bodies as real `skills/<n>/SKILL.md`) and `compose: sandboxComposeAgent` (the single agent file). No `TargetSpec` change.
2. **Everything but skill bodies folds into the agent file.** `instructions` and `mcp_server` have **empty per-type renderers** (`() => ({})` / an empty `MaterializeResult`) so they aren't skip-reported, and `compose` reads them from the gem and emits them inline in the agent file (`instructions:` string; `mcpServers: [...]` server instances). This is the same "handled by compose" pattern Flue used for instructions, extended to MCP because the SDK embeds MCP servers in the agent (no separate connection files).
3. **Native stdio MCP — no proxy.** http/sse → `MCPServerStreamableHttp`; stdio → `MCPServerStdio` (command/args + secrets as `env`). `mcpProxy.ts` is **not** used by this target.
4. **Skills seeded via Manifest `localDir`, not inlined.** `defaultManifest` mounts the real `skills/` dir read-only (`localDir({ from: "skills", readOnly: true })`) and enables `skills()` + `filesystem()` so the agent can read them regardless of exact skill auto-discovery. Keeps skill bodies in real files (reuse `skillSkillMd`), not escaped into TS.
5. **Hooks unsupported → skipped** with a reason.
6. **Secret-safe.** Auth/env read `process.env["<NAME>"]` from `secretRefs` (names only); no secret value emitted. http auth → `requestInit.headers.Authorization`; stdio secrets → `env`.
7. **No `package.json` / run harness scaffold in v1.** Emit the source (agent file + skills); the operator installs `@openai/agents` and wires `run(agent, …)`. Named out of scope (parallels Eve/Flue).

## 3. Support matrix (openai-sandbox column)

| artifact | output |
|----------|--------|
| skill | `skills/<n>/SKILL.md` (shared `skillSkillMd`); seeded via Manifest `localDir` |
| instructions | folded into `<gemname>.agent.ts` `instructions:` (no standalone file) |
| *(compose)* | `<gemname>.agent.ts` — `new SandboxAgent({ … })` with capabilities + manifest + mcpServers |
| mcp_server (http/sse) | inline `new MCPServerStreamableHttp({ url, name, requestInit:{headers:{Authorization: process.env["<TOK>"]!}} })` |
| mcp_server (stdio) | inline `new MCPServerStdio({ command, args, env:{<NAME>: process.env["<NAME>"]!}, name })` |
| hook | — skip (no native concept) |

## 4. The composer (`src/gem/targets.ts`)

`sandboxComposeAgent(gem): MaterializeResult` (uses the `compose` hook; receives the whole gem):
```ts
import { SandboxAgent, Manifest, localDir, shell, filesystem, skills } from "@openai/agents/sandbox";
import { MCPServerStreamableHttp, MCPServerStdio } from "@openai/agents";  // only the classes used

export const agent = new SandboxAgent({
  name: "<gemname>",
  model: "gpt-5.5",
  instructions: `<concatenated, template-escaped instruction artifacts>`,
  capabilities: [shell(), filesystem(), skills()],            // skills()/skills-entry only if skills exist
  defaultManifest: new Manifest({ entries: { skills: localDir({ from: "skills", readOnly: true }) } }),
  mcpServers: [
    new MCPServerStreamableHttp({ name: "<n>", url: "<url>", requestInit: { headers: { Authorization: process.env["<TOK>"]! } } }),
    new MCPServerStdio({ name: "<n>", command: "<cmd>", args: [..], env: { <NAME>: process.env["<NAME>"]! } }),
  ],
});
```
Details:
- File path `<safePathSegment(gem.name)>.agent.ts`.
- Imports are emitted conditionally: the `@openai/agents` MCP import line only lists the classes actually used (StreamableHttp and/or Stdio); omitted entirely when there are no MCP servers. The sandbox import always present.
- `capabilities` includes `skills()` and the `defaultManifest` `skills` entry **only when the gem has skills**; otherwise an empty/minimal manifest (`new Manifest({ entries: {} })`) and `capabilities: [shell(), filesystem()]`.
- `instructions` is template-escaped (`\` → `\\`, `` ` `` → `` \` ``, `${` → `\${`) — reuse the `escapeTemplate` helper added for Flue.
- `mcpServers` rendering + skip rules:
  - http/sse with a real `url` → `MCPServerStreamableHttp`. Auth from a `headers.authorization` secretRef → `requestInit.headers.Authorization = process.env["<NAME>"]!`; other `headers.*` secrets → additional header entries. A non-`headers.` secret → **skip** that server with a reason.
  - stdio with a real `command` → `MCPServerStdio`; `args` from config; secrets → `env: { <NAME>: process.env["<NAME>"]! }` (names only).
  - otherwise → skip with a reason.
- `sandboxComposeAgent` returns `{ files: { "<name>.agent.ts": … }, skipped: [...] }` (skips are unmappable MCP servers).

Registry entry:
```ts
"openai-sandbox": { id: "openai-sandbox", label: "OpenAI Sandbox", skill: skillSkillMd, instructions: () => ({}), mcp: () => ({ files: {}, skipped: [] }), compose: sandboxComposeAgent },
```
(The empty `mcp` renderer marks MCP "handled by compose" so servers aren't skip-reported by the per-type path; the real MCP mapping + skip-reporting happens in `sandboxComposeAgent`.)

## 5. Surface — no schema change; one UI option

- `TargetId` union gains `"openai-sandbox"`; `TargetIdSchema = z.enum(Object.keys(TARGET_REGISTRY))` extends automatically → compatibility records, workspace `renderedTargets`, and `MaterializeRequest/Response` validate `openai-sandbox` with **no `schemas.ts` change**.
- Workspace per-target tabs are dynamic → the tab appears automatically.
- **UI (`src/public/index.html`):** add `<option value="openai-sandbox">OpenAI Sandbox</option>` to the Materialize-preview `<select id="target">`.

## 6. Module changes

- `src/gem/targets.ts` — `TargetId` gains `"openai-sandbox"`; `sandboxComposeAgent` (+ small MCP-server render helpers); the registry entry. Reuses `skillSkillMd`, `safePathSegment`, `escapeTemplate`, the `compose` hook + merge. **Does not** use `mcpProxy.ts`.
- `src/public/index.html` — one `<option>`.

## 7. Testing

- **`src/gem/__tests__/targets.test.ts` (unit, external fidelity to the SDK):**
  - skill → `skills/<n>/SKILL.md` (exact content).
  - agent file → `<gemname>.agent.ts` containing `new SandboxAgent`, the `@openai/agents/sandbox` import, `capabilities: [shell(), filesystem(), skills()]`, `defaultManifest: new Manifest(` with the `skills: localDir(` entry, and the instructions string. Instruction artifacts are NOT in `skipped`; skill bodies are NOT inlined into the agent file.
  - http MCP → inline `new MCPServerStreamableHttp(` with the url and `process.env["<TOK>"]` auth in `requestInit.headers.Authorization`; no secret value.
  - stdio MCP → inline `new MCPServerStdio(` with `command`/`args` and `env: { <NAME>: process.env["<NAME>"] }`; NO proxy file emitted (assert `proxies/` is absent).
  - hook → **skipped** with reason; a non-`headers.` MCP secret → that server **skipped**.
  - no-skills gem → agent file has `capabilities: [shell(), filesystem()]` and no `skills` manifest entry (valid TS).
  - instructions template escaping (backtick + `${`).
  - `compatibility(gem)` includes an `openai-sandbox` entry; secret-safety: no emitted file contains a secret value.
- **Page (gstack at verify time):** materialize-preview target **OpenAI Sandbox** shows `<name>.agent.ts` + `skills/…`; and a workspace **openai-sandbox** tab renders `.targets/openai-sandbox/`.

## 8. Out of scope (named follow-ups)

- **`package.json` / `run()` harness / sandbox-client wiring** — operator installs `@openai/agents` and writes the run loop.
- **`memory()`/`compaction` capabilities, mounts (`s3Mount`…), `gitRepo` skill sources, handoffs/tools** — v1 emits skills + instructions + MCP; richer capabilities are later additions.
- **Hosted MCP (`hostedMcpTool`/connectors) and OAuth `authProvider`** — v1 uses the direct server classes with env-token auth.
- **SSE-specific server class** — http and sse both map to `MCPServerStreamableHttp` (the SDK's modern transport); a dedicated legacy-SSE class can be added if needed.

## 9. Platform fit

`openai-sandbox` extends producible portability to a fifth code-gen surface and validates the `compose` hook across a genuinely different harness: native stdio MCP (no proxy), inline `mcpServers`, and a workspace-seeding Manifest — none of which the per-type renderer model could express, all of which `compose` handles cleanly. As a pure `TARGET_REGISTRY` entry it lights up `materialize`, `compatibility`, and every workspace's `.targets/openai-sandbox/` with zero changes to archive, workspaces, or schema layers.
