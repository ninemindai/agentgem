# Architecture

This page is the technical map of AgentGem: how a request flows from a client, through
the contract surface, into the framework-agnostic Gem core, and out to archives, targets,
the registry, and deploy backends. For the conceptual "why," read [Concepts](concepts.md)
first.

## The big picture

![AgentGem system architecture](diagrams/system-architecture.svg)

> Diagram: [`diagrams/system-architecture.svg`](diagrams/system-architecture.svg) ·
> [PNG](diagrams/system-architecture.png) ·
> [interactive HTML](diagrams/system-architecture.html) (Copy / PNG / PDF export)

There are four horizontal bands:

1. **Hosts / clients** — the web UI (`src/public/index.html`), any local coding agent, and
   the [Desktop app](desktop.md), which embeds the same server in Electron (tray + auto-update).
2. **Contract surface** — one Zod definition per operation, surfaced as a REST endpoint, an
   MCP tool, and an OpenAPI 3.1 document. See [the one-contract model](#the-one-contract-model).
3. **Gem core** (`src/gem/`) — pure, framework-agnostic functions: `introspect` → `redact`
   → `buildGem` → `archive`. See the [build pipeline](pipeline.md).
4. **Distribution** — the neutral Gem feeds targets (materialize), the registry, deploy
   backends, and local testbeds/runs. See [distribution](#distribution) below.

An optional **workflow-aware recommendation** path sits in front of the core: `POST
/workflow/analyze` (plus an SSE progress stream) scans a project's Claude transcripts into a
deterministic `WorkflowSignal`, asks a local ACP agent to cluster and name a Gem (degrading to a
frequency ranking if the agent is unavailable), and emits a pre-checked `GemSelection` that feeds
`buildGem`. It only ranks and explains what introspection already found — see [Analyze](analyze.md).

Server-side state lives under `~/.agentgem` (workspaces, recents, credentials, deploy
records) — never inside a Gem.

## The one-contract model

AgentGem is built on **AgentBack**. The entry point `src/index.ts` wires a single
`RestApplication` with both an HTTP server and an MCP server:

```ts
const app = new RestApplication({});
app.configure("servers.RestServer").to({ port, host: "127.0.0.1" });
app.component(MCPComponent);
app.configure("servers.MCPServer").to({ name: "agentgem", version: "0.1.0", transports: { stdio: false } });
app.restController(GemController);   // REST  → /api/*
app.service(GemTools);              // MCP   → /mcp
await installExplorer(app, { title: "agentgem API" }); // OpenAPI + Swagger → /explorer
await installMcpHttp(app);
```

| Boundary | Surfaced by | Path | Notes |
| --- | --- | --- | --- |
| REST | `GemController` (`@api`) | `/api/*` | 35+ endpoints; the stateful surface (workspaces, deploy, publish) |
| MCP | `GemTools` (`@mcpServer`) | `/mcp` | 6 tools; read + plan operations for agents |
| OpenAPI / Swagger | `installExplorer` | `/explorer` | Derived from the same Zod schemas |
| Web UI | Express route | `/` | Serves the single-page builder |

REST and MCP are **not** parallel re-implementations: both call the same helper functions
(e.g. `introspectAll`, `buildGem`) and validate against the same schemas in
`src/schemas.ts`. The REST surface simply adds the stateful operations (workspace CRUD,
run, deploy, publish) that a UI needs; MCP focuses on the read-and-plan operations an agent
needs. See the full list in the [API reference](api-reference.md).

Because every operation is decorator-defined, the build **must** compile with
`experimentalDecorators` + `emitDecoratorMetadata` — see [Development](development.md).

## The Gem core

Everything under `src/gem/` is framework-agnostic — no HTTP, no decorators, just functions
over plain data. That is what lets the same code back a web request, an MCP tool call, and
a test. The pipeline is documented in detail in [The build pipeline](pipeline.md); the
on-disk result is specified in [Archive format](archive-format.md); the safety rule that
governs all of it is in [Redaction](redaction.md).

| Module | Responsibility |
| --- | --- |
| `introspect.ts` | Read `~/.claude`, plugins, `~/.agents`, `~/.codex`, `~/.hermes`, and project dirs into a `ConfigInventory` |
| `redact.ts` | Strip secret values at capture; record `SecretRef[]` |
| `buildGem.ts` | Select artifacts by name → a `Gem` (+ checks, `requiredSecrets`) |
| `archive.ts` | Lay a Gem out as `gem.json` (manifest) + `gem.lock` and verify integrity |
| `archiveFs.ts` / `archiveTar.ts` | Serialize the file tree to a directory or a deterministic `.tar.gz` |
| `checks.ts` | Scaffold behavioral + external (`skillspector`) checks |
| `types.ts` | The core types: `Gem`, `GemArtifact`, `ConfigInventory`, `GemCheck`, … |

## Distribution

The Gem is a neutral source. Three subsystems consume it, plus local testbeds and runs.

![AgentGem distribution](diagrams/distribution.svg)

> Diagram: [`diagrams/distribution.svg`](diagrams/distribution.svg) ·
> [PNG](diagrams/distribution.png) ·
> [interactive HTML](diagrams/distribution.html)

- **Targets** (`targets.ts`) — `materialize(gem, target)` runs per-artifact renderers and a
  cross-cutting `compose` hook to emit a `FileTree`. Code-gen targets: Eve, Flue, OpenAI
  Sandbox, AgentCore, and A2A (an [Agent Card](a2a.md) projection with an opt-in runnable
  server) — plus the editor targets claude/codex/agents/hermes. See
  [Targets & deploy](targets.md).
- **Registry** (`registry.ts`, `registryGithub.ts`) — a GitHub-backed index plus per-version
  item archives; publish / resolve / merge / install with semver and a dependency graph. See
  [Registry](registry.md).
- **Deploy backends** (`deploy.ts`, `publish.ts`, `agentcorePublish.ts`) — Anthropic Managed
  Agents and AWS Bedrock AgentCore, each recorded in a deploy record that drives Undeploy.
- **Testbed & Run** (`testbed.ts`, `run.ts`) — install a Gem into a local `.claude`/`.codex`/
  `.hermes` testbed, or run/deploy a materialized project locally, to Vercel, or to
  Cloudflare. See [Testbed & run](testbed-and-run.md).

## Source layout

```
src/
  index.ts            # AgentBack wiring: REST + MCP + Explorer on one app
  cli.ts              # `agentgem` bin — starts the server
  gem.controller.ts   # REST surface (@api) — /api/*
  gem.tools.ts        # MCP surface (@mcpServer) — /mcp
  schemas.ts          # Zod schemas shared by both surfaces
  workflowStream.ts   # SSE handler for /workflow/analyze progress
  resolveDir.ts       # config-dir + ~/.agentgem home resolution
  pickFolder.ts       # OS-native folder picker (for the UI)
  publish.ts          # Anthropic Managed Agents publish/undeploy client
  public/index.html   # single-page Gem Builder UI
  gem/                # framework-agnostic core (pipeline, targets, registry, run,
                      #   workflowScan, acpRecommender, …)
desktop/              # Electron host — embeds the server (tray + auto-update)
docs/
  diagrams/           # .svg (for docs), .png (fallback), .html (interactive export)
```

## Where to go next

- [The build pipeline](pipeline.md) — introspect → redact → buildGem → archive
- [Archive format](archive-format.md) — the manifest + lock spec
- [Redaction](redaction.md) — the trust boundary and its rules
- [API reference](api-reference.md) — every REST endpoint and MCP tool
- [Targets & deploy](targets.md) · [Registry](registry.md) · [Testbed & run](testbed-and-run.md)
- [Development](development.md) — build, test, and contribute
