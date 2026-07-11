# Publish confirmation, versioning, and sharing scope for miniapps

**Date:** 2026-07-11
**Status:** Design approved, spec under review
**Scope:** Two sequential PRs, sharing one new Publish dialog

## Problem

When a user publishes a miniapp from Studio to app.agentgem.ai, two things are
missing today:

1. **No "already exists" awareness.** Re-publishing an app the user already owns
   *silently overwrites* it. The server upserts on `(gem_key, version)`
   (`packages/aggregator/src/catalog.ts:22`) and Studio hardcodes
   `version: "0.1.0"` (`packages/console/src/panels/Play/Studio.tsx:210`), so every
   re-publish clobbers the same row. There is no confirmation and no way to keep the
   previous version.

2. **No sharing scope.** There is no `visibility` concept at all. "Public" = a
   `catalog_gems` row exists (listed in Explore); "unlisted" = a separate,
   lighter "Copy share link" flow that writes an archive-only row
   (`gem_archives`, no catalog entry). "Private" does not exist.

## Goals

- On publish, detect an existing app and let the user choose **overwrite** vs.
  **publish as a new (auto-bumped) version**.
- Give every publish a **scope**: Private / Unlisted / Public, enforced
  server-side.
- Retire the legacy standalone "Copy share link" quick-share; publish becomes the
  single funnel, and its scope selector owns "unlisted."

## Non-goals

- Reclaiming orphaned NULL-owner catalog rows (a pre-existing limitation; see Edge
  cases).
- Semver minor/major control, changelogs, or a version-history browsing UI.
- Org/group-scoped visibility (only owner-private is in scope; the org lattice
  already exists separately).
- Migrating already-shared `/games/<id>` archive links (they keep resolving).

## Current architecture (verified)

**Publish path (A — the marketplace):**
`Studio.tsx` `publishWorkspace()` → `POST /api/publish-setup` →
`POST /api/aggregator/publish-gem` (`src/aggregator.controller.ts:293`) →
`recordCatalogShare` (`catalog.ts:202`) → `upsertCatalogGem` (`catalog.ts:22`,
`onConflictDoUpdate` on `(gemKey, version)`).

**Identity:** publish is signed (ed25519) and the account is resolved server-side
via `resolveSignedAccount` (`catalog.ts:171`). `owner_account_id` is the real
ownership key; `published_by` is display-only attribution. The publish guard
(`catalog.ts:221`) rejects with `"conflict"` when a row exists under a *different*
owner.

**Read paths (all anonymous today):**
- Explore list: `GET /api/registry/gems` (`src/gem.controller.ts:1253`) →
  `listCatalogGems` (`catalog.ts:40`) — `SELECT ... FROM catalog_gems` with **no
  WHERE**; returns every row.
- Single-gem resolve: `GET /api/aggregator/gem-archive` and `game-meta`/`game-html`
  (`aggregator.controller.ts:359-393`); `archiveOnlyVersion` (`catalog.ts:129`)
  distinguishes archive-only "unlisted" rows from catalog rows.
- Client (`packages/console/src/api/routes.ts:976`) sends **no identity** on reads.

**Precedent for authenticated reads:** private org skills. Public reads hard-filter
`org_scope IS NULL` (`packages/aggregator/src/curatedSkills.ts:72`); private rows
are served only through a session-gated endpoint that calls
`resolveSession(auth, req.headers)` → `{ accountId, login }`
(`src/githubApp/orgsApi.ts:59`). PR 2 copies this shape.

**Legacy quick-share (to retire):** Studio "Copy share link" `mintShare()`
(`Studio.tsx:253`) → `POST /api/play/share` → `shareArchive`
(`aggregator.controller.ts:316`), writing an archive-only row with a slash-less
`genShareId`, served at `/games/<id>`.

---

## PR 1 — "Already exists" confirmation + real versions

No schema change. The DB PK is already `(gem_key, version)`; the only blocker to
real versioning is the hardcoded version string.

### Pre-flight status check

New **signed** endpoint (refined during planning — the console authenticates to the
aggregator by ed25519 signature, not a session cookie, so this mirrors the existing
signed `/api/aggregator/catalog` publish rather than the session-gated org reads):

```
POST /api/aggregator/gem-status   body { key, pubkey, signedAt, signature }
  → resolveSignedAccount(db, ...)   (ed25519, 5-min freshness — same as publish)
  → { exists: boolean, ownedByMe: boolean, latestVersion: string | null }
```

Signing happens server-to-server in the console's local server
(`src/gem.controller.ts`, which already loads the producer key via
`loadOrCreateIdentity` and signs publishes); the browser reaches it through a thin
local proxy route `GET /api/publish-status`. Existence + latest version are public;
`ownedByMe` is true only for the verified owner. Reuses `latestGemVersion`
(`catalog.ts:74`) plus an `owner_account_id === accountId` comparison. **No
`originGuard`/CORS/session changes** — a signed POST behaves exactly like the
existing publish POST.

### Publish dialog behavior

The dialog calls `gem-status` first, then branches:

| Status | Dialog |
|---|---|
| Doesn't exist | Publish directly as `0.1.0`. |
| Exists & mine | Two actions: **Overwrite `v<latest>`** (upsert same version) or **Publish as new version** → auto-bump patch (`0.1.0 → 0.1.1`, no editing). |
| Exists, not mine | Server already rejects `"conflict"`; dialog surfaces "that name is taken by another account" instead of a raw error. |

### Version resolution

- First publish → `0.1.0`.
- Overwrite → `latestVersion`.
- New version → `bumpPatch(latestVersion)` via a small semver util
  (`0.1.0 → 0.1.1`).

Replace the hardcoded `version: "0.1.0"` in `Studio.tsx:210` (and the equivalent in
`Curate/PublishToExplore.tsx`) with the version the dialog resolved. Multiple
versions then coexist as separate `(gem_key, version)` rows; "latest" continues to
be newest `created_at_ms` (`latestGemVersion`).

### Tests (PR 1)

- `bumpPatch` util (semver edge cases).
- `gem-status`: exists/ownedByMe/latestVersion across not-exists, owner, non-owner,
  NULL-owner.
- New-version publish creates a second row; overwrite replaces in place.

---

## PR 2 — Private / Unlisted / Public

> **Split during planning (2026-07-11):** PR 2 divides at the Private boundary.
> **PR 2a** = `visibility` column + publish threading + Explore filter + the
> Public/Unlisted selector + retire the legacy quick-share (delivers two of three
> scopes honestly; unlisted needs no enforcement — hidden from Explore but reachable
> by its already-routable `/games/@scope/name` link). Plan:
> `docs/superpowers/plans/2026-07-11-publish-visibility-pr2a.md`. To avoid shipping a
> fake "private," PR 2a's publish edge accepts only `public`|`unlisted`.
> **PR 2b** = **Private** with real owner-only enforcement (resolve gate on the
> anonymous `game-meta`/`gem-archive` endpoints + session-gated `my-gems` +
> originGuard changes) — planned after 2a lands, with the open question of how an
> owner accesses their own private gem (metadata-only / marketplace-session /
> console-signed) settled then.

### Schema

Add to `catalog_gems` (`packages/aggregator/src/schema.ts:264`):

```
visibility text NOT NULL DEFAULT 'public'   -- 'public' | 'unlisted' | 'private'
```

Paired with an idempotent `alter table catalog_gems add column if not exists
visibility text not null default 'public'` in `ensureSchema` (per the column-drift
rule — a Drizzle table change alone does not migrate existing deployments). Legacy
rows default to `'public'`.

### Enforcement matrix

| Visibility | Explore list (anon `/registry/gems`) | Resolve/install by key |
|---|---|---|
| **public** | listed | anyone |
| **unlisted** | not listed | anyone with the link/key |
| **private** | not listed | **owner only** (session-gated) |

Implementation:

- **Anonymous list** — `listCatalogGems` gains `WHERE visibility = 'public'` (treat
  NULL as public for safety). Removes private *and* unlisted from Explore.
- **Single-gem resolve** — `game-meta` / `gem-archive` check the catalog row's
  visibility. `private` → require `resolveSession` and
  `owner_account_id === accountId`, else `403`. `unlisted` / `public` → serve as
  today. (Archive-only rows have no catalog row and keep resolving via
  `archiveOnlyVersion`.)
- **Owner sees own private/unlisted** — new session-gated read
  `GET /api/aggregator/my-gems` filtering `owner_account_id = session.accountId`,
  following `buildOrgCatalog`'s owner filter (`orgCatalog.ts:64`). The console's
  "my published apps" view uses this instead of the anonymous list.
- **`visibility` is set at publish** — carried inside the **signed** publish payload
  → threaded through `recordCatalogShare` → `upsertCatalogGem` set-clause. Signed =
  tamper-proof; only the owner can publish anyway.

### Retire the legacy quick-share

- Remove the Studio "Copy share link" button and `mintShare()` (`Studio.tsx:253`),
  and the `/api/play/share` client route.
- The server mint/revoke routes (`share-archive`, `share-archive/revoke`) become
  dead; delete them in this PR.
- **Keep the resolve path** (`game-meta`/`game-html` + `archiveOnlyVersion`)
  untouched so already-shared `/games/<id>` links keep working.
- New shareable links come only from an **unlisted publish**: a published gem's
  share link uses its scoped key (`/games/@scope/name`). The `/games/:key` route
  must accept slashes (raw path) — verify during implementation (see
  `entityPath.ts`; game paths are raw, not percent-encoded).

### Console UI

Add a scope selector (Private / Unlisted / Public radio) to the Publish dialog
built in PR 1, in Studio and Curate. Default: Public (matches today's behavior).

### Tests (PR 2)

- `listCatalogGems` excludes non-public rows; includes NULL as public.
- Private resolve: `403` for anonymous / non-owner, `200` for owner.
- `my-gems` returns only the caller's rows.
- `visibility` round-trips through signed publish into the row.

---

## Edge cases

- **Orphaned NULL-owner rows** (from `backfillGemOwners`) reject *all* re-publish as
  `"conflict"` (`catalog.ts:221`, `null !== accountId`) and are unreclaimable via
  publish. Out of scope; documented as a known limitation.
- **Existing archive-only `/games/<id>` shares** keep resolving after the
  quick-share retirement.
- **Slash-in-key** for unlisted `/games/@scope/name` links — must be handled by the
  raw game-path route.

## Testing note

CI only gates the root `dist/__tests__` suite. Aggregator and console tests
(vitest + typecheck) are **not** in CI and must be run locally before each PR.
