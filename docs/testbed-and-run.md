# Testbed & run

Beyond building and distributing Gems, AgentGem can install a Gem into a local **testbed**
to try it, and **run** a materialized target locally or deploy it to an edge platform. Both
subsystems live in `src/gem/` and store state under `~/.agentgem` (override with
`AGENTGEM_HOME`).

## Testbeds

A testbed is a real agent project on disk that a Gem's artifacts are written into, so you can
run the agent and see the Gem in action. Testbeds come in **flavors**, each mapping artifacts
to that ecosystem's conventions (`testbedFlavors.ts`):

| Flavor | Skills dir | Instructions file | MCP config | Hooks | Run |
| --- | --- | --- | --- | --- | --- |
| `claude` | `.claude/skills/<name>/SKILL.md` | `CLAUDE.md` | `.mcp.json` | yes | `claude` |
| `codex` | `.agents/skills/<name>/SKILL.md` | `AGENTS.md` | `.codex/config.toml` | no | `codex` |
| `hermes` | `.hermes/skills/<name>/DESCRIPTION.md` | `.hermes/SOUL.md` | — | no | `hermes` |

Key operations:

- **Detect / suggest** — `detectFlavor(root)` reads marker files (`.claude`, `.codex`,
  `.hermes`); `suggestTestbed(root)` proposes a flavor and name from the cwd.
- **Discover** — `discoverProjects()` mines recent projects from session history (Claude
  `~/.claude/projects/**.jsonl`, Codex `~/.codex/sessions/**.jsonl`) so the UI can offer
  "open a recent project."
- **Scaffold** — `scaffoldTestbed(root, name, flavor?)` creates the flavor's skeleton.
- **Import** — `importArtifacts(root, selection, inventory, flavor?)` writes selected skills,
  instructions (appended with idempotency markers), MCP servers (raw config via the flavor's
  `writeMcp`), and hooks (upserted into `.claude/settings.json`). Imported artifacts go to the
  testbed **as live config**, not serialized into a Gem.

`recents.ts` keeps `~/.agentgem/recents.json` (deduped by path, newest first, capped at 10).

## Workspaces

A **workspace** (`workspaces.ts`) is a saved Gem under `~/.agentgem/workspaces/<name>/`: the
canonical archive at the root, with rendered target outputs under `.targets/<target>/`.
`createWorkspace` writes the archive; `readWorkspace` verifies the lock and computes target
compatibility; `renderTarget` materializes the Gem to a target and writes the output.

## Run & deploy

`run.ts` renders a workspace to a runnable project under `.run/` and drives a process:

| Mode | Command | Target | URL parsed from logs |
| --- | --- | --- | --- |
| `local` | `eve build` → `eve start` | eve | `http://localhost:…` |
| `vercel` | `vercel deploy --yes --token … --scope …` | eve | `https://<id>.vercel.app` |
| `cloudflare` | `wrangler deploy` | flue | `https://<name>.<acct>.workers.dev` |

`runReadiness()` reports which modes are configured (by checking env tokens). A `RunState`
(`{ mode, state, url?, logTail }`) is tracked in-memory per `name:target`, and a circular
log buffer keeps the last ~200 lines. Vercel/Cloudflare deploys persist a
[deploy record](targets.md) so they can be undeployed later; `undeployVercel` /
`undeployCloudflare` reverse them.

### Managed & AWS backends

Distinct from local/edge runs are the managed publish backends — Anthropic Managed Agents
and AWS Bedrock AgentCore — documented in [Targets & deploy](targets.md). AgentCore also has
a CLI-driven path (`agentcoreRun.ts`) that renders the harness project and shells out to the
`agentcore` CLI.

## stdio MCP proxying

URL-only runtimes (like Eve) can't speak to a local **stdio** MCP server. `mcpProxy.ts`
generates a small standalone Node script (`stdioProxyRunner`) that spawns the stdio server
and re-serves it over HTTP at `127.0.0.1:<port>/mcp`. The operator runs it where the agent
runs; secrets are never embedded — the proxy inherits the operator's environment.

## Server credentials

`credentials.ts` stores server-side tokens (`ANTHROPIC_API_KEY`, `VERCEL_TOKEN`,
`CLOUDFLARE_API_TOKEN`) in `~/.agentgem/.env` (mode `0600`), loaded at startup and set in
`process.env` for deploys. These are server config — never part of a Gem (see
[Redaction](redaction.md)).
