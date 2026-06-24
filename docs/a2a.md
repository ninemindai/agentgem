# A2A: agent-to-agent interoperability

[A2A](https://a2a-protocol.org/) (Agent-to-Agent) is an open protocol for agents to
**discover and call each other**. AgentGem can export any Gem as an A2A target — so
the agent you built locally becomes something other agents can find and invoke, not
just a config you keep to yourself.

A2A is one of AgentGem's [materialize targets](targets.md) (target id `a2a`). It has
two modes, picked with one toggle:

- **Agent Card** (default) — a single `agent-card.json` describing your agent in the
  A2A format. Portable, runtime-free metadata for discovery.
- **A2A server** (opt-in) — a self-contained, runnable server that serves the Card
  **and** executes your agent over JSON-RPC and REST, with streaming and optional
  auth.

## Export an Agent Card

Select **A2A** as the target in the Gem Builder, leave the server toggle off, and
materialize. You get one file:

- **`agent-card.json`** — an [A2A Agent Card](https://a2a-protocol.org/) (protocol
  `0.3.0`) with your agent's `name`, `description` (the first prose line of your
  instructions), `version`, and a `skills` array (one entry per skill, metadata
  only — no bodies, no secrets). A Gem with no skills gets a synthesized `chat`
  skill, since A2A requires at least one.

The Card is the discoverable description of your agent: publish it, and other agents
can read what your agent does and how to reach it.

## Run an A2A server

Select **A2A**, then turn on **"Emit runnable server (AI SDK v7) — otherwise just
the Agent Card"**. Materializing now produces a full project:

| File | Purpose |
| --- | --- |
| `agent-card.json` | The Card, with `streaming` and `pushNotifications` enabled and its URLs filled in |
| `src/server.ts` | An [AI SDK v7](https://ai-sdk.dev/) server that runs your agent |
| `package.json` | Dependencies (`ai`, `@a2a-js/sdk`, `express`, …) and scripts |
| `tsconfig.json` | TypeScript config |
| `SECRETS.md` | How to supply the credentials your agent needs |

The server exposes three endpoints:

| Endpoint | What it does |
| --- | --- |
| `GET /.well-known/agent` | Serves the Agent Card for discovery — always open |
| `POST /a2a/jsonrpc` | JSON-RPC interface (the primary A2A surface) |
| `POST /a2a/rest` | HTTP + JSON interface |

Requests run your agent through a streaming tool loop and publish the standard A2A
**task lifecycle** — `task` (submitted) → `status-update` (working) →
`artifact-update` (incremental text deltas) → `status-update` (completed) — so
callers get results as they're produced. Push notifications are supported by the
generated handler.

### Configuration

The server reads everything it needs from the environment:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `41241` | Port to listen on |
| `PUBLIC_URL` | `http://localhost:<port>` | Base URL written into the Agent Card |
| `A2A_API_KEY` | — | If set, requires `Authorization: Bearer <key>` on the `/a2a/*` routes (discovery stays open) |
| `AI_GATEWAY_API_KEY` *or* `ANTHROPIC_API_KEY` | — | Model access (the server runs `anthropic/claude-sonnet-4-6` via the AI SDK) |
| *MCP secret names* | — | Any credentials your Gem's MCP servers require — see `SECRETS.md` |

When `A2A_API_KEY` is set, the served Card advertises a bearer `securitySchemes`
entry so callers know auth is required. Leave it unset for an open, local server.

Because A2A is a code-gen target, AgentGem hands you the project rather than hosting
it — run it locally (`npm install && npm run dev`), containerize it, or deploy it to
any Node host. As with every target, secrets are referenced by name only; no raw
values are ever written into the generated files.

## Why it matters

Exporting to A2A is the first step of AgentGem's larger arc: a Gem isn't just a
config you copy — it's an agent others can **discover and call**. The Agent Card
makes your agent describable; the server makes it callable. Together they turn a
local setup into a service on the agent network.
