# Installable Shared Setups (v1) — Design

**Date:** 2026-07-06
**Status:** Approved scope + registry-free model, pending spec review

## Problem

When a local AgentGem app "shares its setup" to app.agentgem.ai, the shared gem
should be **previewable** and **installable/reusable by other users**. Today it is
neither:

- **Share link** writes only a social card (`shareCards`: name + a counts string
  like `"3 skills · 2 MCPs"`). No content, no catalog row.
- **Publish to Explore** (`POST /api/gem/playbook/publish` → `postCatalogShare`)
  writes a `catalog_gems` **metadata** row flagged `installable: false`. The
  handler reads the gem archive only to derive `grade` + `artifactKinds`, then
  **discards the bytes** — the content is uploaded nowhere a consumer can reach.
- The public browse list (`/api/registry/gems`, `src/gem/publicCatalog.ts`) marks
  every catalog row `installable: false`.
- `catalog_gems` stores only artifact **kinds**, not the per-artifact names, so
  there is no data to render a contents preview.

**Goal:** a user shares their local setup → another user browses it on the
marketplace, **previews its contents** (an expandable tree), and **installs it
with zero configuration**, with **explicit consent** for executable artifacts.

## Decisions (from brainstorming)

- **Install model:** hosted, zero-config, **registry-free**. app.agentgem.ai
  stores the gem `{ archive bytes, manifest }` directly. Publishing uploads both;
  a consumer previews the manifest and downloads the archive over plain public
  HTTP. There is NO GitHub registry and NO `AGENTGEM_REGISTRY_REPO` anywhere in
  this path (that mechanism stays for the separate BYO-registry publish flow, but
  shared setups do not use it).
- **Archive storage:** a Postgres `gem_archives` table (bytea) in the aggregator
  DB the hosted server already has — no new object-storage infra for v1. (Object
  storage / R2 is a scale follow-up if archive sizes warrant it.)
- **Trust model:** preview + explicit consent. The preview flags executable
  artifacts (MCP servers, hooks); the console install requires acknowledgement of
  what will run before applying.
- **Target scope:** Claude only for v1 (the target whose spec supports all four
  kinds — skill / instructions / mcp / hook, `packages/model/src/targets.ts`
  ~977). Other targets already have documented drop behavior and follow later.
- **Integrity:** the `.gem` archive still carries its manifest + `gem.lock`, so
  the console verifies the digest on install (`importGem`) regardless of transport.

## Scope

**In scope (the vertical slice):** publish `{archive, manifest}` to a hosted store
→ catalog artifact tree → preview UI → public archive download → config-free
install + consent, for the Claude target.

**Out of scope (follow-ups):** non-Claude targets; sandboxing/static analysis of
hooks & MCP; org-private/team-scoped setups; object-storage backend; ratings-gated
install; versioned rollback UI.

## Endpoints (registry-free)

- `POST /api/gem/publish` — **gated** (signed-in session + owns the scope).
  Body: `{ scope, name, version, archiveBase64, manifest }`. Stores the archive
  in `gem_archives` and upserts `catalog_gems` (with `artifacts` + `installable:
  true`) from the manifest.
- `GET /api/gem/:key/:version/manifest` — **public** read. Returns the manifest
  (artifacts tree, description, tags, grade) for the preview. (`:key` is the
  URL-encoded gem key.)
- `GET /api/gem/:key/:version/archive` — **public** read. Streams the `.gem`
  archive bytes for install. Serves only `installable: true` gems.

`/api/registry/gems` continues to power browse but now returns `artifacts` and a
true `installable` flag for hosted-store gems.

## Components

Each component is independently testable with a clear interface.

### 1. Publish `{archive, manifest}` (console → hosted store)

**What:** the console's "Share/Publish setup" flow uploads the built `.gem`
archive **and** its manifest to the hosted store, replacing the metadata-only
`postCatalogShare` path for setups.

- The console builds the archive (`readGemArchive(readWorkspace(...))`) and derives
  the manifest (artifacts `[{name,type}]`, description, tags, grade).
- `POST /api/gem/publish` (gated: session + scope ownership) stores the archive in
  `gem_archives` and upserts `catalog_gems` with `artifacts` + `installable: true`.
- One call produces both installable content and browse/preview data.

**Interface:** `publishSetup({ scope, name, version, archiveBase64, manifest })`.
**Key files:** `packages/console/src/panels/Curate/PublishToExplore.tsx`,
`packages/console/src/panels/Observe/index.tsx` (onPublishSetup),
`packages/console/src/api/routes.ts`, new publish handler in `src/gem.controller.ts`,
`packages/aggregator/src/catalog.ts` (+ archive store).

### 2. Catalog: artifact tree + archive store

**What:** persist the manifest's artifact list (for preview) and the archive bytes
(for install).

- `catalog_gems` gains `artifacts jsonb` — `[{ name, type }]`. `executes` is
  derived (type ∈ {`hook`, `mcp_server`}), not stored.
- New `gem_archives` table: `(gem_key text, version text, bytes bytea, size int,
  digest text, created_at_ms bigint, primary key (gem_key, version))`.
- Migrations follow the `ensureSchema` pattern: `create table if not exists
  gem_archives …` and `alter table catalog_gems add column if not exists artifacts
  jsonb` (existing DBs must back-fill the column — see the ensureSchema-column-drift
  lesson; a CREATE-only change silently skips live tables).

**Key files:** `packages/aggregator/src/schema.ts` (tables + ensureSchema),
`packages/aggregator/src/catalog.ts` (upsert + reads), `src/schemas.ts` (manifest).

### 3. Preview UI (marketplace)

**What:** an expandable, grouped-by-kind tree on the gem detail page.

- The gem page fetches `GET /api/gem/:key/:version/manifest` (or reads `artifacts`
  off the browse row) and renders a NEW grouped tree component (not the flat
  `Gem.ingredients` list, which stays for curated-ingredient gems).
- Render grouped by kind with counts and expand/collapse: `Skills (300) ▸`,
  `⚠ MCP servers (3) ▸`, `⚠ Hooks (1) ▸`, `Instructions (2) ▸`. Executable groups
  carry a warning affordance; large groups collapse by default. Items show the
  name; link only where a known skill/ingredient page exists, else plain text.
- The "Open in AgentGem" button (existing `agentgem://get-gems?q=<key>`) becomes
  the install entry point.

**Key files:** `packages/marketplace/src/pages/Gem.tsx`,
`packages/marketplace/src/gems/catalog.ts`, `styles.css`,
`packages/marketplace/src/types.ts`.

### 4. Public archive download (hosted)

**What:** stream a shared gem's archive by key + version, no consumer config.

- `GET /api/gem/:key/:version/archive` reads `gem_archives` and returns the bytes
  for an `installable: true` gem; 404 otherwise.
- originGuard: a public, side-effect-free GET — add to `PUBLIC_READ_PATHS` (or the
  hosted public prefix), mirroring the aggregator public reads.

**Key files:** `src/index.ts` (route mount), a new handler in `src/gem.controller.ts`
or `src/registry/`, `src/originGuard.ts` (public-read entry),
`packages/aggregator/src/catalog.ts` (archive read).

### 5. Config-free install + consent (console)

**What:** install a gem key by downloading from the hosted store — no
`AGENTGEM_REGISTRY_REPO` — after an explicit consent step.

- New install path: given a `gemKey` (+ version), `GET
  <hostedBase>/api/gem/:key/:version/archive` (hostedBase defaults to
  `https://api.agentgem.ai`, overridable), `importGem` (verifies digest + lock),
  and materialize into the **Claude** target / workspace. Bypasses
  `resolveInstall`'s registry-source requirement entirely.
- **Consent gate:** before applying, inspect the archive's artifacts and present
  what will run — MCP servers (with commands) and hooks — and require
  acknowledgement. Skills/instructions shown as safe.
- Wired to the existing "Open in AgentGem" / Get Gems flow: the `?q=<key>` deep
  link lands on the gem; the console offers **Install** which runs this path.

**Interface:** `hostedInstall({ gemKey, version?, hostedBase? }, onConsent)`.
**Key files:** `packages/console/src/panels/GetGems/index.tsx`,
`packages/console/src/api/routes.ts`, install handler (`src/gem.controller.ts` or
console-side fetch+`importGem`+materialize), `packages/model/src/targets.ts`.

## Data flow

```
A (local console)  — Share / Publish setup
  → build .gem archive + manifest (artifacts, grade, tags)
  → POST /api/gem/publish { scope, name, version, archiveBase64, manifest }   [gated]
      → gem_archives ← archive bytes
      → catalog_gems ← { ..., artifacts, installable: true }

B (marketplace, browser)
  → GET /api/registry/gems (or /api/gem/:key/:version/manifest)  → artifacts
  → Gem.tsx renders expandable tree (⚠ executable groups)
  → click "Open in AgentGem" (agentgem://get-gems?q=<key>)

B (local console)
  → GET /api/gem/:key/:version/archive   → .gem bytes   [public, zero-config]
  → importGem (verify digest + lock)
  → consent dialog (MCP commands + hooks) → acknowledge
  → materialize into Claude target (.claude/)
```

## Error handling

- Publish without a signed-in session / scope ownership → 401/403 with a clear
  "sign in / not your scope" message.
- `GET …/archive` or `…/manifest` for an unknown or non-installable gem → 404.
- Archive fails digest/lock verification (`importGem`) → abort, never partially
  materialize.
- Consent declined → no files written.
- Oversized archive on publish → 413 with the cap in the message.

## Testing

- **Unit:** publish stores archive + upserts catalog with `artifacts` +
  `installable: true`; `/manifest` and `/archive` return correct data / 404;
  consent derivation (which artifacts are executable); Claude target materializes
  all four kinds; archive size cap enforced.
- **Integration/e2e:** publish a small setup locally → browse it (tree) → hosted
  install into a fresh workspace → assert skills/instructions/mcp/hooks land and
  the consent step gated on the executable ones, with NO registry configured.
- **Guard:** `/api/gem/:key/:version/archive` reachable cross-site as a public
  read and side-effect-free.

## Security considerations

- Executable artifacts (hooks, MCP) run on install → mitigated by preview flags +
  explicit console consent (the design's central safety mechanism).
- Public archive download serves only sharer-published (`installable: true`) bytes.
- Publish stays gated by session + scope ownership.
- Archive size cap on publish to bound storage/abuse (value TBD in the plan).

## Deployment prerequisite

None beyond the hosted aggregator Postgres the app already runs — the archive
lives in `gem_archives` there. (This removes the earlier GitHub-registry token
requirement entirely.)

## Open questions

- Archive size cap value (the test gem had 306 artifacts; measure a real archive).
- Republish/version semantics when a sharer updates their setup.
- Whether to move archive bytes to object storage (R2) if sizes grow — the store
  read/write is isolated behind `catalog.ts`, so this is a later swap.
