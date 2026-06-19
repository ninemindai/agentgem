# agentgem — Local Gem-Builder Web UI on AgentBack (Design)

**Date:** 2026-06-14
**Status:** Approved design, pre-implementation
**Project:** `agentgem` (new standalone repo at `/Users/rfeng/Projects/ninemind/agentgem`)
**Scope:** A local web UI that introspects the operator's coding-agent config (skills, MCP servers, CLAUDE.md), lets them check what to bundle, and builds a **secret-redacted Gem** — built as an **AgentBack hybrid app** so the same `inventory`/`gem` operations are exposed as REST endpoints *and* MCP tools from one Zod contract.

---

## 1. Why AgentBack (one contract, every boundary)

The gem capability already exists as pure functions in `workflow-profiler` (`introspect`/`buildPack`/`redact`). A browser can't read `~/.claude` (sandbox), so a local server is required. Building that server on **AgentBack** (the ninemind AI-native API/MCP framework) means a single Zod-defined operation becomes:

- a **REST endpoint** (for the web page),
- an **MCP tool** (so the operator's local agent can call `inventory`/`gem` directly — agent-native),
- an **OpenAPI 3.1** doc + Swagger `/explorer`, a typed client, and runtime validation,

all from the same definition. It also dogfoods AgentBack. The web page is just one client of the contract.

## 2. Stack & build model

- **Deps:** `@agentback/core`, `@agentback/rest`, `@agentback/mcp`, `@agentback/mcp-http`, `@agentback/openapi` (all `0.2.2`, published to npm); `@agentback/testing` (dev). **zod v4**. TypeScript 6 with `experimentalDecorators` + `emitDecoratorMetadata`. pnpm. vitest.
- **Build required:** AgentBack uses legacy decorators → `tsc -b` then `node dist/index.js`. **Not `tsx`.** (This is why agentgem is its own repo, not folded into the `tsx`/zod-3 `workflow-profiler`.)
- **Scaffold:** `pnpm create agentback` (hybrid REST+MCP template), then add the gem pieces. If the template differs, mirror `examples/hello-hybrid` in the agentback repo.

## 3. Modules

```
agentgem/
  src/
    gem/                 # gem-core PORTED from workflow-profiler (pure TS, no zod dep)
      types.ts            # ConfigInventory, Gem, PackArtifact union
      redact.ts           # redactMcpConfig (value + key-name redaction)
      introspect.ts       # introspectConfig(claudeDir) -> ConfigInventory (redacts at capture)
      buildPack.ts        # buildPack(inventory, selection) -> Gem
    schemas.ts            # zod v4 wire schemas: InventorySchema, PackSelectionSchema, PackSchema
    gem.controller.ts    # @api({basePath:'/api'}) GET /inventory, POST /gem
    public/index.html     # two-pane page (layout B): vanilla JS, no build
    index.ts             # AgentBack app: RestApplication (+ MCP), static serve public/, register controller, start
  package.json tsconfig.json vitest.config.ts
  tests/...               # ported gem-core tests + controller tests
```

Each `src/gem/*` file and its tests are ported verbatim from `workflow-profiler` (they have no zod dependency, so they drop in unchanged). `schemas.ts` defines the zod-v4 wire contract; it must agree with the gem-core TS types.

## 4. The contract (REST endpoint = MCP tool)

Controller (`@agentback/openapi` decorators, AgentBack `RestApplication`):

- `GET /api/inventory` → handler calls `introspectConfig(claudeDir)` → `ConfigInventory`. Response validated by `InventorySchema`. Exposed as MCP tool `inventory`.
- `POST /api/gem` body `{ selection: PackSelection, name?: string }` → handler re-introspects, then `buildPack(inventory, selection, { name, createdFrom })` → `Gem`. Validated by `PackSchema`. Exposed as MCP tool `gem`. **Stateless** (selection refers to artifacts by name).
- `claudeDir` defaults to `~/.claude`; overridable via query param `?dir=` (for testing / non-default homes).

Free from AgentBack: `GET /openapi.json`, Swagger UI at `/explorer`, MCP over HTTP at `/mcp` (so a local agent can call the same tools), machine-actionable validation errors.

## 5. The page (layout B — approved)

`public/index.html`, served statically at `/`. Vanilla JS, no build:

- On load, `fetch('/api/inventory')` → render the **left pane**: grouped checkboxes (Skills with descriptions, MCP servers with transport, an "Include CLAUDE.md" toggle).
- On any selection change (debounced), `POST /api/gem` with the current selection + gem name → render the **right pane**: the live, pretty-printed `gem.json` (secrets already `<redacted>`), plus a **Download gem.json** button and a **Copy** action.
- A gem-name input. An empty selection shows an empty-ish gem and a hint.
- Minimal, clean styling (system font, two columns); this is a local utility, not a showcase.

## 6. Trust boundary

`introspectConfig` redacts MCP secrets **at capture** (value-based + key-name-based, per the workflow-profiler hardening). So every response — REST and MCP — and the rendered preview carry only redacted config shapes, never secret values. This is the same boundary the CLI enforces; serving it over HTTP/MCP does not weaken it.

## 7. Testing

- **gem-core:** port the existing `redact`/`introspect`/`buildPack` tests verbatim (they pass in workflow-profiler).
- **Controller (`@agentback/testing`):** start the app in-process (port 0), `GET /api/inventory?dir=<temp fake ~/.claude>` returns the seeded skills/MCP/CLAUDE.md with secrets redacted; `POST /api/gem` with a selection returns a `Gem` with the chosen artifacts and `env.*` redacted; an unknown selection returns a validation/`buildPack` error envelope.
- **Page:** smoke-tested with the gstack browser at verify time — load `/`, confirm the inventory renders, toggling a checkbox updates the live preview, and the preview contains `<redacted>` (never a raw secret), Download works.

## 8. Run

`pnpm install && pnpm build && pnpm start` (→ `node dist/index.js`) starts the server on `127.0.0.1:<port>` and prints the URL. Open it for the UI; `/explorer` for the API; `/mcp` for the MCP endpoint.

## 9. Out of scope (later)

- De-duplicating gem-core with `workflow-profiler` (shared package / cross-dep) — ported copy for now; pure files, low drift.
- Publishing the Gem to a managed backend (Managed Agents / Flue) — separate deferred sub-project; agentgem only *builds* Packs.
- Plugin-bundled artifact introspection, project-level `.claude/`, commands/subagents/settings (v2 of gem-core).
- Auth/multi-user, a hosted deployment, gem registry. agentgem is a **local** single-operator utility.

## 10. Platform fit

agentgem is the visual front door to the gem capability and the first **AgentBack** app in the ninemind platform — proving the "one Zod contract → REST + MCP" model on a real internal tool. The same `inventory`/`gem` MCP tools make config-packing available to the operator's local agent, reinforcing the agent-native thesis; the Gem it emits feeds the (deferred) publish-to-Managed-Agents step.
