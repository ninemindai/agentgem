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
| `gem_export` | `{ selection, name?, version?, dir?, projects? }` | a portable `.gem` archive, base64-encoded |
| `gem_install` | `{ gemUrl? \| gemPath? \| bytesBase64? }` | the lock-verified Gem + manifest meta |
| `transfer_send` | `{ selection, name?, version?, dir?, projects? }` | a one-time `agentgem://` ticket (needs `NATS_URL`) |
| `transfer_receive` | `{ ticket }` | the verified Gem + manifest meta (needs `NATS_URL`) |

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

### Run

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/run-ready` | Check local run readiness — returns `{ local: boolean }` |
| POST | `/run` | Start a local run of a rendered target (`mode: "local"`) |
| GET | `/run-status` | Poll run status |
| POST | `/run/stop` | Stop a local run |

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

### Marketplace, benchmark, memory & cards

Beyond the local Gem-building surface above, the server (and the hosted marketplace it
proxies) exposes several endpoint families. These are documented in full by the generated
OpenAPI document at `/explorer`; the groups are:

| Group | Where | What it covers |
| --- | --- | --- |
| **Publish & catalog** | hosted marketplace | Publish with a **visibility scope** (Public/Unlisted/Private) + **versioning** pre-flight (`/api/publish-status`), Explore/browse (`GET /api/registry/gems`), zero-config install (`POST /api/install-hosted`), stars, reviews |
| **Review-gated publishing & groups** | hosted marketplace | Review requests inbox (list/detail/approve/request-changes/comment/withdraw), groups (create/join/members/invites), group-shared private gems |
| **Identity** | hosted marketplace | better-auth sign-in (GitHub/Google/passkeys), account linking, `/@handle` profiles, orgs + org **benchmark governance** |
| **Benchmark contribution** | hosted marketplace + `/api/benchmark` proxy | Consent-gated ingest of ingredients-only attestations, signed `POST /my-gems`, k-anon benchmark read-back |
| **Memory sync** | local core | Provider config, pull provider memories into recall, consent-gated push outbox (`/api/memory/*`, local-only — gated on `SERVE_CONSOLE`) |
| **OG cards** | hosted marketplace | `GET /og/card.png?type=&key=` — branded/screenshot link-preview cards (see [Sharing](sharing.md#branded-link-previews)) |

### Misc

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/pick-folder` | Pop an OS-native folder picker on the server machine |

## Notes

- **Streaming.** Long-running analyses (insights, workflow analyze, rubric evaluation,
  scorecard scan, gem run/verify) stream over agentback **`streamOf` routes** sharing a
  common pump (`src/sse/pump.ts`) rather than ad-hoc SSE handlers.

- **Directory override.** Inventory-style operations accept `?dir=` (and `projects`) to point
  at a non-default config home — used for testing and non-default setups.
- **Schemas.** Request/response shapes are Zod schemas in `src/schemas.ts`
  (`InventorySchema`, `GemSchema`, `MaterializeRequestSchema`, `InstallPlanSchema`, …). The
  OpenAPI document at `/explorer` is generated from them and validated at runtime.
- **Readiness gates.** `*-ready` endpoints report whether required credentials / CLIs are
  present, so the UI can disable actions instead of failing mid-flight.
