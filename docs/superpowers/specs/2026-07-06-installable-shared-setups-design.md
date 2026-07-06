# Installable Shared Setups (v1) — Design

**Date:** 2026-07-06
**Status:** Approved scope, pending spec review

## Problem

When a local AgentGem app "shares its setup" to app.agentgem.ai, the shared gem
should be **previewable** and **installable/reusable by other users**. Today it is
neither:

- **Share link** writes only a social card (`shareCards`: name + a counts string
  like `"3 skills · 2 MCPs"`). No content, no catalog row.
- **Publish to Explore** (`POST /api/gem/playbook/publish` → `postCatalogShare`)
  writes a `catalog_gems` **metadata** row flagged `installable: false`. The
  handler reads the gem archive only to derive `grade` + `artifactKinds`, then
  **discards the bytes** — it never calls `publishGem`, so the content is uploaded
  nowhere a consumer can reach.
- The public browse list (`/api/registry/gems`, `src/gem/publicCatalog.ts`) marks
  every catalog row `installable: false`, and a DB teaser **overwrites** any
  installable registry row on key collision.
- The only installable publish paths (`/api/registry/publish`,
  `/api/registry/upload-publish`) write the `.gem` archive to a GitHub registry
  repo, and a consumer can install only if their console is configured to that
  **same** registry (`AGENTGEM_REGISTRY_REPO` + token).
- `catalog_gems` stores only artifact **kinds**, not the per-artifact names, so
  there is no data to render a contents preview.

**Goal:** a user shares their local setup → another user browses it on the
marketplace, **previews its contents** (an expandable tree), and **installs it
with zero configuration**, with **explicit consent** for executable artifacts.

## Decisions (from brainstorming)

- **Install model:** hosted, zero-config. Reuse the existing GitHub registry as
  the content store (no new blob infra); add a **public download** endpoint so a
  consumer pulls the archive with no token and no `AGENTGEM_REGISTRY_REPO`.
- **Trust model:** preview + explicit consent. The preview flags executable
  artifacts (MCP servers, hooks); the console install requires acknowledgement of
  what will run before applying.
- **Target scope:** Claude only for v1 (the target whose spec supports all four
  kinds — skill / instructions / mcp / hook, per `packages/model/src/targets.ts`
  line ~977). Other targets already have documented drop behavior and follow later.

## Scope

**In scope (the vertical slice):** publish content → catalog artifact tree →
preview UI → public download → config-free install + consent, for the Claude
target.

**Out of scope (follow-ups):** non-Claude targets; sandboxing/static analysis of
hooks & MCP; org-private/team-scoped setups; ratings-gated install; archive size
limits & abuse controls beyond a basic cap; versioned rollback UI.

## Components

Each component is independently testable with a clear interface.

### 1. Publish content (console → hosted)

**What:** the console's "Share/Publish setup" flow uploads the built `.gem`
archive to the hosted registry **and** records the artifact list for preview.

- The console already builds the archive (`readGemArchive(readWorkspace(...))`).
  For a setup publish, `upload-publish` **replaces** the metadata-only
  `postCatalogShare` path: POST the archive bytes to `POST /api/registry/upload-publish`
  (existing, credentialed: session + scope ownership), which `importGem`s and
  `publishGem`s into the GitHub registry — making the gem genuinely installable.
- `upload-publish` is extended to upsert the catalog row from the archive's
  manifest with the artifact list (Component 2) and `installable: true`, so the
  single publish call produces both installable content and browse/preview data.
  (The legacy `postCatalogShare` metadata-only path remains for callers that only
  want a teaser, but the setup flow no longer uses it.)

**Interface:** `uploadPublish({ archiveBytes, scope, name, version, artifacts })`.
**Depends on:** existing `upload-publish` handler, `catalogShareClient`,
`importGem`/`publishGem`.
**Key files:** `packages/console/src/panels/Curate/PublishToExplore.tsx`,
`packages/console/src/panels/Observe/index.tsx` (onPublishSetup),
`src/registry/uploadPublish.ts`, `src/gem/catalogShareClient.ts`.

### 2. Catalog: artifact tree

**What:** persist the per-artifact list so the marketplace can preview it.

- `catalog_gems` gains `artifacts jsonb` — an array of `{ name: string, type:
  ArtifactType }`. `executes` is derived (type ∈ {`hook`, `mcp_server`}), not
  stored.
- Migration follows the established `ensureSchema` pattern: a paired
  `alter table catalog_gems add column if not exists artifacts jsonb` (existing
  DBs must back-fill — see the ensureSchema-column-drift lesson; a CREATE-only
  change silently skips live tables).
- The publish manifest (`CatalogManifest`) carries `artifacts`; `upsertCatalogGem`
  writes it.

**Interface:** `CatalogManifest.artifacts?: {name,type}[]`; catalog rows expose
`artifacts`.
**Key files:** `packages/aggregator/src/schema.ts` (table + ensureSchema),
`packages/aggregator/src/catalog.ts`, `src/gem/catalogShareClient.ts`,
`src/schemas.ts` (manifest schema).

### 3. Preview UI (marketplace)

**What:** an expandable tree in the gem detail page.

- `/api/registry/gems` (and/or a gem-detail read) returns `artifacts`; the
  marketplace `RegistryGem`/`toGem` carry it through. The gem page renders a NEW
  grouped-by-kind tree component (not the existing flat `Gem.ingredients` list,
  which stays for curated-ingredient gems).
- Render grouped by kind with counts and expand/collapse: `Skills (300) ▸`,
  `⚠ MCP servers (3) ▸`, `⚠ Hooks (1) ▸`, `Instructions (2) ▸`. Executable groups
  carry a warning affordance. Large groups collapse by default.
- Individual items show the name; link only where a known skill/ingredient page
  exists, else plain text (custom artifacts have no detail page).

**Key files:** `packages/marketplace/src/pages/Gem.tsx`,
`packages/marketplace/src/gems/catalog.ts` (toGem), `styles.css`,
`packages/marketplace/src/types.ts` (RegistryGem).

### 4. Public download endpoint

**What:** stream a shared gem's archive by key + version, no consumer token.

- New hosted route `GET /api/registry/download?key=<gemKey>&version=<v>` that
  reads the archive from the GitHub registry (server-side token) and returns the
  `.gem` bytes. Serves only `installable: true` catalog gems (content the sharer
  chose to publish).
- originGuard: a public, side-effect-free read — add to `PUBLIC_READ_PATHS` (safe
  GET) or give it its own public gate, mirroring the aggregator public reads.

**Key files:** `src/index.ts` (route mount, alongside upload-publish),
`src/registry/` (new download handler), `src/originGuard.ts` (public-read entry),
`packages/distribute/src/registryGithub.ts` (fetch archive).

### 5. Config-free install + consent (console)

**What:** install a gem key by pulling from the hosted download — no
`AGENTGEM_REGISTRY_REPO` — after an explicit consent step.

- A new install path: given a `gemKey` (+ optional version), fetch the archive
  from the hosted download URL (hosted base defaults to `https://api.agentgem.ai`,
  overridable), `importGem` it, and materialize into the **Claude** target /
  workspace. This bypasses `resolveInstall`'s registry-source requirement.
- **Consent gate:** before applying, inspect the archive's artifacts and present
  what will run — MCP servers (with their commands) and hooks — and require
  acknowledgement. Skills/instructions are shown as safe.
- Wired to the existing "Open in AgentGem" / Get Gems flow: the `?q=<key>` deep
  link lands on the gem, the console offers **Install** which runs this path.

**Interface:** `hostedInstall({ gemKey, version?, hostedBase? }): Promise<Plan>`
with a consent callback surfaced in the UI.
**Depends on:** Component 4 (download), `importGem`, Claude target materialize.
**Key files:** `packages/console/src/panels/GetGems/index.tsx`,
`packages/console/src/api/routes.ts`, a new install route in `src/gem.controller.ts`
or a console-side fetch+materialize, `packages/model/src/targets.ts` (Claude).

## Data flow

```
A (local console)
  Share/Publish setup
    → build .gem archive (readGemArchive)
    → POST /api/registry/upload-publish { bytesBase64, scope, name, version }
        → importGem + publishGem → GitHub registry (installable)
        → upsertCatalogGem { ..., artifacts, installable: true }

B (marketplace, app.agentgem.ai)
  GET /api/registry/gems → gem row incl. artifacts
    → Gem.tsx renders expandable tree (⚠ executable groups)
  Click "Open in AgentGem" (agentgem://get-gems?q=<key>) / "Install"
    → console: GET /api/registry/download?key&version → .gem bytes
    → importGem → consent dialog (MCP commands + hooks) → acknowledge
    → materialize into Claude target
```

## Error handling

- Publish without a signed-in session / scope ownership → existing 401/403 from
  `upload-publish`; surface a clear "sign in / not your scope" message.
- Download of a non-installable or unknown gem → 404.
- Install when the archive fails digest/lock verification (`importGem`) → abort
  with a clear error; never partially materialize.
- Consent declined → no files written.
- Hosted server without a registry token configured → `upload-publish` /
  `download` unavailable; the marketplace shows the browse-only state and the
  manual steps (graceful degradation). **Deployment prerequisite** (see below).

## Testing

- **Unit:** catalog `artifacts` round-trip (manifest → row → `/registry/gems`);
  `publicCatalog` sets `installable: true` when content uploaded; download
  endpoint returns bytes for an installable gem and 404 otherwise; consent
  derivation (which artifacts are flagged executable); Claude target materializes
  all four kinds.
- **Integration/e2e:** publish a small setup locally → browse it → hosted install
  into a fresh workspace → assert skills/instructions/mcp/hooks land and the
  consent step gated on the executable ones.
- **Guard:** `/api/registry/download` reachable cross-site as a public read;
  stays side-effect-free.

## Security considerations

- Executable artifacts (hooks, MCP) run on install → mitigated by preview flags +
  explicit console consent (this design's central safety mechanism).
- Public download serves only sharer-published (`installable: true`) content.
- Publish stays gated by session + scope ownership (existing).
- Basic archive size cap to avoid abuse (value TBD in the plan).

## Deployment prerequisite

`upload-publish` (and the new `download`) mount only when the hosted server has
`AGENTGEM_REGISTRY_REPO` + `GITHUB_TOKEN` (`src/index.ts` ~223-230). v1 requires
provisioning a hosted registry repo + token on the app/api deployment. If absent,
the feature degrades to browse-only. Confirm/provision before rollout.

## Open questions

- Archive size limits for large setups (the test gem had 306 artifacts).
- Whether to also flag the localhost fallback + `agentgem://` deep link to prefer
  the hosted install once available (ties into the open-in-agentgem-deeplink work).
- Versioning/update semantics when a sharer republishes (later).
