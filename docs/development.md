# Development

How to build, test, and contribute to AgentGem.

## Prerequisites

- Node.js (LTS) and [pnpm](https://pnpm.io/).
- A coding-agent config at `~/.claude` for real introspection (tests use fixtures and
  `?dir=` / `resolveDirs` overrides instead).

## Build, run, test

```bash
pnpm install
pnpm build      # tsc -b, then copies the UI into dist/
pnpm start      # node dist/index.js  (UI /, Explorer /explorer, MCP /mcp)
pnpm dev        # build + start in one step
pnpm test       # tsc -b && vitest run
pnpm clean      # rm -rf dist *.tsbuildinfo
```

## Why the build is compiled, not transpiled

AgentBack defines REST endpoints and MCP tools with **decorators** (`@api`, `@get`, `@post`,
`@mcpServer`, `@tool`). The framework reads decorator metadata at runtime, so `tsconfig.json`
sets `experimentalDecorators: true` and `emitDecoratorMetadata: true` (with
`useDefineForClassFields: false` for legacy-decorator compatibility). You must compile with
`tsc -b` — a transpile-only path that drops decorator metadata will fail at runtime. The
build is incremental (`.tsbuildinfo`).

## Tests run against `dist/`

`vitest.config.ts` includes `dist/**/__tests__/**/*.test.js` — tests run against the
**compiled** output, not the `.ts` source. Consequences:

- `pnpm test` runs `tsc -b` first; an empty `dist/` means no tests are found.
- After renames or moves, run `pnpm clean` before testing so stale compiled tests in `dist/`
  don't shadow the new layout.

The suite covers the core thoroughly: the pipeline (`introspect`, `redact`, `buildGem`,
`archive`, `archiveFs`, `archiveTar`), targets, the registry (publish/resolve/merge/install),
deploy and deploy records, testbed flavors, run, credentials, the MCP proxy, and TOML.

## Code organization conventions

- **The `@agentgem/*` packages are framework-agnostic.** The kernel lives in `packages/*`
  (12 acyclic workspace packages) — no HTTP, no decorators, just functions over plain data.
  The REST controller and MCP service in `src/` are thin adapters that call into them. Keep
  new core logic in the right package so it stays testable and reusable across both surfaces;
  see the [package map](architecture.md#the-gem-core-agentgem-packages).
- **Every source file carries the MIT/SPDX header** (`// Copyright (c) 2026 NineMind, Inc.`
  + `// SPDX-License-Identifier: MIT`), below any shebang.
- **One contract per operation.** Add or change a Zod schema in `src/schemas.ts`, then surface
  it on the REST controller and/or the MCP service. Don't hand-write a second schema for the
  other surface — see [Architecture](architecture.md#the-one-contract-model).
- **Redaction is non-negotiable.** Any new path that reads config must redact at capture; any
  new artifact type that can hold secrets must carry `secretRefs`. See [Redaction](redaction.md).
- **Adding a target** mostly means describing how a Gem *materializes* — implement the
  per-type renderers and/or the `compose` hook on a `TargetSpec` and register it. See
  [Targets & deploy](targets.md).

## Concurrent sessions

Use a dedicated git worktree per session so branches and build artifacts (`dist/`,
`tsconfig.tsbuildinfo`) don't collide (see [`CLAUDE.md`](../CLAUDE.md)):

```bash
git worktree add ../agentgem-<task> -b <task>
# … work …
git worktree remove ../agentgem-<task>
```

## Diagrams

The docs diagrams live in `docs/diagrams/` in three formats per diagram:

- `*.svg` — embedded in the markdown docs (renders inline on GitHub);
- `*.png` — a 2× raster fallback, regenerated with
  `rsvg-convert -z 2 <name>.svg -o <name>.png`;
- `*.html` — a self-contained interactive version with Copy / PNG / PDF export, built with
  the architecture-diagram design system.

If you edit a diagram, update the `.svg` and re-render the `.png`.
