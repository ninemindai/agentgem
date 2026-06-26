# Input containment audit

The AgentGem server runs on the local machine and binds to `127.0.0.1`. Every
state-changing route is additionally protected by the
[`originGuard`](../src/originGuard.ts), which blocks cross-site and `Origin: null`
POSTs — so a remote page cannot drive these endpoints in the victim's browser.

This document audits the remaining boundary: the **filesystem- and
network-affecting inputs** that outward-facing `POST` routes accept and act on. Each
input is either **confined** (sanitized and containment-asserted, with a regression
test) or **safe by design** (a local path/URL the user explicitly supplies, the same
trust model as the rest of a local-first tool — see the out-of-scope note in
[`SECURITY.md`](../SECURITY.md)).

## How a rejection is reported

A guard that refuses a caller-supplied value throws
[`InvalidInputError`](../src/gem/inputError.ts), which carries `statusCode: 400`.
`@agentback/rest` hides the message of any `>= 500` error (returning a generic
`Internal Server Error`) but surfaces a `4xx` message verbatim — so a blocked request
returns `400 { code: "invalid_input", message: "<the violated rule>" }` instead of an
opaque 500. This matches how the zod body/param validators already report bad input,
and applies on both the REST and MCP surfaces (the error envelope is shared).

The canonical confinement helpers are:

- [`workspaceName(name)`](../src/gem/workspaces.ts) — rejects any name that is not a
  single safe path segment (`[A-Za-z0-9._-]`, no separators, no `.`/`..`), so two
  requests never collide and nothing escapes the workspace store. `workspaceDir`,
  and therefore every deploy-record path, routes through it.
- [`deriveRunDir(gemName)`](../src/gem.controller.ts) — slugs the gem name and asserts
  the resolved dir stays under `~/.agentgem/runs`.
- [`fetchGemBytes`](../src/gem/safeFetch.ts) — SSRF guard that rejects URLs resolving
  to non-public (loopback/private/link-local) addresses.
- [`setCredential`](../src/gem/credentials.ts) — allowlisted keys only; rejects
  empty/multi-line values so the persisted `.env` cannot be injected.

## Route-by-route disposition

| Route | Input | Disposition |
|-------|-------|-------------|
| `POST /api/run` | `name` | **Confined** — `startLocal`/`deployVercel`/`deployCloudflare` → `ensureRunProject` → `workspaceDir` → `workspaceName()`. The eve run-dir basename is the slugged `vercelProject(name)`. Traversal names fail closed (no spawn, no dir outside the root). |
| `POST /api/undeploy` | `name` | **Confined** — `undeployVercel`/`undeployCloudflare` use `workspaceDir(name)` as cwd; `readDeployRecord(name)` → `recPath` → `workspaceDir` → `workspaceName()`. |
| `POST /api/publish` | `wsName` | **Confined** — `writeDeployRecord(wsName)` → `workspaceDir` → `workspaceName()`. |
| `POST /api/publish` / `POST /api/publish-preview` | `name` | **Safe by design** — used only as the gem-manifest name, never as a filesystem path. |
| `POST /api/publish` / `POST /api/publish-preview` | network target | **Safe by design** — deploy goes through fixed endpoints (Anthropic SDK client / Bedrock AgentCore control plane). No caller-supplied URL, so no SSRF. |
| `POST /api/publish`, `/api/publish-preview`, `/api/materialize`, `/api/archive` | `dir`, `projects` | **Safe by design** — the local introspection root the user points the tool at; the same trusted local path the whole app reads. |
| `POST /api/credential` | `key` | **Confined** — zod `z.enum(CREDENTIAL_KEYS)` allowlist (`ANTHROPIC_API_KEY`, `VERCEL_TOKEN`, `CLOUDFLARE_API_TOKEN`). |
| `POST /api/credential` | `value` | **Confined** — `setCredential` rejects empty/multi-line values (no `.env` line injection). |
| `POST /api/materialize` | `gemUrl` | **Confined** — `fetchGemBytes` SSRF guard. |
| `POST /api/materialize` | `gemPath`, `archivePath` | **Safe by design** — local read path the user supplies; archive integrity is independently verified against `gem.lock` (tampering is rejected). |
| `POST /api/archive` | `outDir`, `outFile` | **Safe by design** — local write path the user supplies (via the OS folder picker). |

## Regression tests

Each confined input has a guard test:

| Input | Test |
|-------|------|
| `/api/run` `name` traversal | `dist/__tests__/gem.controller.test.js` — "POST /api/run mode=local confines a traversal name" |
| `name`/`wsName` → deploy record | `dist/gem/__tests__/deployRecord.test.js` — "rejects a traversal name on read/write/clear" |
| `workspaceDir` traversal | `dist/gem/__tests__/workspaces.test.js` — "workspaceDir rejects names with separators or traversal" |
| `/api/credential` `key` allowlist | `dist/__tests__/gem.controller.test.js` — "POST /api/credential rejects a non-allowlisted key" |
| `/api/credential` `value` multi-line | `dist/gem/__tests__/credentials.test.js` — "rejects empty or multi-line values" |
| `/api/materialize` `gemUrl` SSRF | `dist/__tests__/gem.controller.test.js` — "POST /api/materialize refuses a gemUrl resolving to a private address" |
