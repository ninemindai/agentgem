# Getting started

AgentGem runs as a small local server. A browser can't read your agent's config
directory (it's sandboxed), so AgentGem serves the introspection and Gem-building
operations from your machine — over both HTTP and MCP — while keeping secrets on-device.

## Prerequisites

- Node.js (LTS) and [pnpm](https://pnpm.io/).
- A supported coding agent — **Claude** (`~/.claude`), **Codex**, or **Hermes** — with
  skills, MCP servers, and instructions. You can point AgentGem at a different directory
  for testing.

## Install and run

```bash
pnpm install
pnpm build      # AgentBack uses legacy decorators — build with tsc, then run dist/
pnpm start      # → node dist/index.js
```

The server starts on `127.0.0.1` and prints its URL. Three things come up from the same
contract:

| Path         | What it is                                              |
| ------------ | ------------------------------------------------------- |
| `/`          | The Gem Builder web UI                                  |
| `/explorer`  | Swagger UI for the REST API (from the OpenAPI document) |
| `/mcp`       | The MCP endpoint, so your local agent can call the same tools |

During development, `pnpm dev` builds and starts in one step.

## Build your first Gem

1. Open `/`. AgentGem calls `GET /api/inventory` and renders your config: skills (with
   descriptions), MCP servers (with transport), and an *Include instructions* toggle
   (e.g. `CLAUDE.md`).
2. Tick the artifacts you want to bundle and give the Gem a name. On each change the page
   calls `POST /api/gem` and shows the live, pretty-printed `gem.json` — secrets already
   shown as `<redacted>`.
3. Download `gem.json` (or copy it). That archive is the neutral source every target and
   the registry consume.

## Targeting a different config directory

Both the UI and the API accept a directory override for testing or non-default homes:

```bash
curl 'http://127.0.0.1:<port>/api/inventory?dir=/path/to/fake/.claude'
```

## Calling it from your agent

Because every operation is also an MCP tool, your local agent can call `inventory` and
`gem` directly over `/mcp` — no browser required. This is the agent-native path: the same
contract the web page uses is available to the agent that's building the Gem.

Next: read **[Concepts](concepts.md)** to understand what's inside a Gem, or jump to
**[Targets & deploy](targets.md)**.
