# API reference

Every operation is defined once as a Zod contract (`src/schemas.ts`) and surfaced three
ways: a REST endpoint (`GemController`, `@api` basePath `/api`), an MCP tool (`GemTools`,
`@mcpServer`), and an OpenAPI 3.1 document with a Swagger UI at `/explorer`. This page lists
the surfaces; `/explorer` is the live, always-current source of request/response shapes.

The server listens on `127.0.0.1` (default port `4317`, override with `PORT`).

## MCP tools — `/mcp`

The agent-facing surface: read and plan. The same helper functions back the REST endpoints.

| Tool | Input | Returns |
| --- | --- | --- |
| `inventory` | `{ dir?, projects? }` | `ConfigInventory` (secrets redacted) |
| `build_gem` | `{ selection, name?, dir?, projects? }` | a redacted `Gem` |
| `registry_index` | `{}` | the registry index (names, versions, dependencies) |
| `registry_resolve` | `{ refs, mode, target? }` | an install plan (no writes) |
| `registry_install` | `{ refs, mode, target? }` | `{ plan, gem }` (resolve + merge) |
| `registry_publish` | `{ workspace, scope, name?, version, deps? }` | publish result (needs `GITHUB_TOKEN`) |

## REST endpoints — `/api`

### Inventory & Gem building

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/inventory` | Introspect skills, MCP servers, instructions, hooks for a dir |
| POST | `/gem` | Build a Gem from introspected config + a selection |
| POST | `/scaffold-checks` | Suggest behavioral + security checks for a Gem |
| POST | `/materialize` | Render a Gem to a target (claude, codex, eve, flue, …) |
| POST | `/archive` | Package a Gem as manifest + lock + files, optionally `.tar.gz` |

### Workspaces

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/workspaces` | Create a named workspace from a Gem |
| GET | `/workspaces` | List saved workspaces |
| GET | `/workspace` | Read a workspace's Gem, files, and target compatibility |
| POST | `/workspace/render` | Render a workspace's Gem to a target |
| POST | `/workspace/delete` | Delete a workspace |

### Run & local/edge deploy

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/run-ready` | Check local / Vercel / Cloudflare readiness |
| POST | `/credential` | Set a server-side credential (`ANTHROPIC_API_KEY`, `VERCEL_TOKEN`, …) |
| POST | `/run` | Start a local run or deploy to Vercel / Cloudflare |
| GET | `/run-status` | Poll run / deploy status |
| POST | `/run/stop` | Stop a local run |

### Managed publish & deploy

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/deploy-targets` | List available publish backends |
| POST | `/publish-preview` | Offline render of the Managed Agents / AgentCore payload (no network) |
| GET | `/publish-ready` | Whether a backend is ready (credentials present) |
| POST | `/publish` | Publish a Gem to Managed Agents or AgentCore |
| POST | `/undeploy` | Tear down a cloud resource (eve / flue / claude-managed / agentcore) |
| GET | `/deploy-record` | Read deploy metadata for a workspace |
| GET | `/agentcore/deploy-ready` | Check AgentCore CLI + AWS credentials |
| POST | `/agentcore/deploy` | Deploy a workspace to AWS via the AgentCore CLI |
| GET | `/agentcore/deploy-status` | Poll AgentCore deploy status |

### Testbed

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/testbed/detect` | Detect a project's flavor (claude / codex / hermes) |
| GET | `/testbed/suggestion` | Suggest a testbed from the cwd |
| GET | `/testbed/recents` | List recently opened testbeds |
| GET | `/testbed/projects` | Discover projects from Claude / Codex session history |
| POST | `/testbed/scaffold` | Create / initialize a testbed (idempotent) |
| POST | `/testbed/import` | Import artifacts (skills, MCP, hooks) from global config into a testbed |

### Analyze & distillation

See [Analyze](analyze.md).

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/workflow/analyze` | Scan a project's transcripts → candidate Gems + distilled draft skills (`WorkflowAnalysis`) |
| GET | `/workflow/analyze/stream` | Same analysis as an SSE stream (`phase` / `delta` / `done` / `failed`); cached per project |
| POST | `/workflow/draft` | Accept a distilled draft → write `~/.agentgem/distilled/<name>/SKILL.md` (kebab name, path-safe) |

`POST /gem` and `/scaffold-checks` accept an optional `distilledDrafts` array; each is staged into
the inventory (by `evidence.root`) before resolution, so a selection can include an accepted draft
by name.

### Registry

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/registry/ready` | Whether the registry is configured |
| GET | `/registry/index` | List available Gems (names, versions, dependencies) |
| POST | `/registry/resolve` | Resolve refs into a dependency plan (no writes) |
| POST | `/registry/install` | Resolve + merge + apply (materialize or workspace) |
| POST | `/registry/publish` | Publish a workspace Gem to the registry (needs `GITHUB_TOKEN`) |

### Misc

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/pick-folder` | Pop an OS-native folder picker on the server machine |

## Notes

- **Directory override.** Inventory-style operations accept `?dir=` (and `projects`) to point
  at a non-default config home — used for testing and non-default setups.
- **Schemas.** Request/response shapes are Zod schemas in `src/schemas.ts`
  (`InventorySchema`, `GemSchema`, `MaterializeRequestSchema`, `InstallPlanSchema`, …). The
  OpenAPI document at `/explorer` is generated from them and validated at runtime.
- **Readiness gates.** `*-ready` endpoints report whether required credentials / CLIs are
  present, so the UI can disable actions instead of failing mid-flight.
