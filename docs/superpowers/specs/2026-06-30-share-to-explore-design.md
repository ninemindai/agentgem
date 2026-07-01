# Share to Explore — DB-backed browse catalog

**Status:** design approved, spec under review
**Date:** 2026-06-30
**Branch:** `share-to-explore`

## Problem

Clicking "Publish to Explore" in the console fails with a generic `500 Internal
Server Error`. Root cause: the flow calls `registryPublish`, which throws
`"the registry is not configured — set AGENTGEM_REGISTRY_REPO"` when the local
server has no GitHub-backed registry (no `AGENTGEM_REGISTRY_REPO` / `GITHUB_TOKEN`).
The uncaught throw is flattened by AgentBack's default error handler to the opaque
envelope, so the real reason never surfaces.

Beyond the bug: requiring every desktop user to stand up a GitHub registry repo +
push token just to appear in the marketplace is the wrong bar. The deployed
aggregator (`api.agentgem.ai`, backed by Neon Postgres) already has the DB, auth,
share-cards, and stars. We want the local console to broadcast a gem into that DB
so it shows on `app.agentgem.ai` — without any per-user GitHub registry.

## Core reframing: `publish` vs `share`

These are two verbs for two intents. This spec adds **share**; it does **not**
change or replace **publish**.

|                | **Publish** (unchanged)            | **Share** (new)                                  |
| -------------- | ---------------------------------- | ------------------------------------------------ |
| Intent         | "here's an installable artifact"   | "here's something I made — come look"            |
| Storage        | GitHub registry (full archive)     | aggregator DB (manifest metadata only)           |
| Installable?   | Yes, versioned                     | No — browse-only teaser                          |
| Attribution    | `publishedBy` via session (same DB)| `publishedBy` via producer-key binding           |
| Prerequisite   | registry repo + write token        | Connect GitHub (device-flow binding)             |

The registry publish path stays in the codebase untouched. `app.agentgem.ai`'s
browse list becomes the **union** of registry-published gems and DB-shared gems.

## Attribution model (the load-bearing decision)

The console is always a **local** app (`SERVE_CONSOLE=false` on `api.agentgem.ai`),
so the sign-in session lives in the **local** pglite DB and the GitHub access token
is discarded after sign-in. The **production** Neon DB behind `api.agentgem.ai`
never sees a local session. Genuine attribution therefore needs a credential the
*hosted* side can verify itself.

We reuse the existing unspoofable primitive:

- The desktop has a persistent ed25519 **producer key** (`~/.agentgem/keypair.json`
  via `loadOrCreateIdentity()`) — the same key that signs telemetry attestations.
- `recordBinding` (already shipped) records `pubkey → verified GitHub login` in the
  production DB's `accountBindings`, proven by (1) an ed25519 signature = key
  possession and (2) a live GitHub token verify = account possession.

**Share = sign the manifest payload with the producer key.** The hosted endpoint
verifies the signature against `pubkey`, looks up `accountBindings` → resolves the
real `@login`, and writes `publishedBy = @login`. No GitHub-token storage, no
sign-in change, not spoofable. Identical trust construction to ingest.

### Connect GitHub — device flow, in the console

The web authorization-code sign-in (`installAuth`) needs a client **secret** and a
hosted callback URL — it is built for the hosted marketplace and is unsafe to ship
in a distributed local app. So binding uses the secret-less **device flow** (public
client id only), surfaced in the console instead of the `agentgem bind` CLI:

> A **"Connect GitHub"** button → local server requests a device code → UI shows
> *"open github.com/login/device, enter code `WXYZ-1234`"* → server polls, gets the
> token, signs `bindSigningPayload`, POSTs to hosted `/api/aggregator/bind` →
> `pubkey → @login` recorded in the production DB. Persists `~/.agentgem/binding.json`.

Login's only job is to *establish the binding*; the ed25519 key does the ongoing
signing. Requires `AGENTGEM_GITHUB_CLIENT_ID` (public) on the local server.

## Components

Each is independently testable.

### 1. Console "Connect GitHub" (device flow) — Phase 1

- **`POST /api/explore/connect/start`** (same-origin, local): calls
  `requestDeviceCode(clientId)`; returns `{ verificationUri, userCode, deviceCode,
  interval }` to the UI. `clientId` from `AGENTGEM_GITHUB_CLIENT_ID`.
- **`POST /api/explore/connect/finish`** (same-origin, local): body `{ deviceCode,
  interval }`; `pollForToken` → token; `loadOrCreateIdentity`; sign
  `bindSigningPayload(pubkey, token, signedAt)`; forward to hosted
  `POST /api/aggregator/bind` via `AGENTGEM_AGGREGATOR_URL` (default
  `https://api.agentgem.ai`); on `{bound:true}` write `~/.agentgem/binding.json`;
  return `{ login }` or a typed error (`unknown-producer` → "share once first so
  your producer key is registered"; `stale`; `provider-error`).
- **`GET /api/explore/identity`** (same-origin, local): reads
  `~/.agentgem/binding.json`; returns `{ connected: boolean, login?: string }`.
- **Console UI**: a small "Connect GitHub" control (in the Curate / Share panel),
  showing the device code + poll state, then "Connected as @login". Gates the Share
  button: disabled with a "Connect GitHub to share" hint when not connected.

Reuses `src/bind/deviceFlow.ts`, `loadOrCreateIdentity`, `bindSigningPayload`,
`recordBinding` (server side, already mounted at `/api/aggregator/bind`).

> **Producer-registration note.** `recordBinding` rejects `unknown-producer` if the
> pubkey has never appeared in `producers`. A producer row is created by the
> existing ingest/attestation path. If a fresh desktop has never shared telemetry,
> binding fails. Resolution: the hosted **share** endpoint (component 3) upserts the
> producer row on first share, and the Connect UI surfaces the typed error telling
> the user to share once first. (Alternative considered: register the producer
> during connect — rejected to keep `bind` semantics unchanged.)

### 2. `catalog_gems` table — Phase 2

New table in `packages/aggregator/src/schema.ts` (+ the `create table if not
exists` mirror used by pglite/tests). Browse-only metadata, one row per
`(gem_key, version)`:

```
gem_key        text     not null     -- "@scope/name"
version        text     not null
published_by   text     not null     -- verified login (from binding lookup)
author         text
description     text
tags           jsonb                 -- string[]
artifact_kinds jsonb                 -- string[]
type           text
grade          integer               -- 1..3, clamped (mirror registry rule)
created_at_ms  bigint   not null
primary key (gem_key, version)
```

No archive bytes (browse-only, "manifest first"). Latest version wins for display.

### 3. Hosted share endpoint — Phase 2

**`POST /api/aggregator/catalog`** on `AggregatorController`.

- Body: `{ manifest: {...RegistryGem discovery fields, grade}, pubkey, signedAt,
  signature }`. `signature` is over `catalogSigningPayload(manifest, pubkey,
  signedAt)` (canonical JSON, freshness window like `recordBinding`).
- Steps: verify ed25519 signature → `accountBindings` lookup by `pubkey`.
  - **no binding → `403 { error: "connect your GitHub account first" }`** (not 500).
  - bad signature → 400; stale → 400.
- Upsert the `producers` row for `pubkey` (resolves the first-share bootstrap in
  component 1's note), then upsert `catalog_gems` with `published_by = binding.login`
  (server-derived; any client-supplied author string is ignored for ownership).
- Sits behind the existing origin guard (CF `X-Origin-Auth` on hosted).
- Rate-limited per pubkey (reuse the aggregator rate-limit extension pattern).

### 4. Console share proxy — Phase 2

**`POST /api/explore/share`** (same-origin, mirrors `ShareProxyController`).

- Reads the workspace's gem archive manifest (`readGemArchive(readWorkspace(name)
  .files)`), extracts RegistryGem discovery fields + `grade`.
- `loadOrCreateIdentity`; sign; forward to hosted `/api/aggregator/catalog`.
- Bundled share-card: after the catalog row lands, mint the existing one-off
  share-card (`kind:"gem"`) via the current `postShare` path so the user also gets
  a `/share/:id` link.
- `playbookPublish`'s `publishPlaybookCore({ publish, share })` seam is reused: for
  the Share verb, `publish()` becomes the DB-catalog call and `share()` stays the
  card mint. Response shape `{ exploreRef, version, shareUrl }` is unchanged, so
  `PublishToExplore.tsx` barely changes (rename to Share; add the connect gate).

### 5. Read merge — Phase 2

**`GET /api/registry/gems`** (already read by `app.agentgem.ai`): return the union
of DB `catalog_gems` rows and the existing GitHub registry index, DB winning on
`gem_key` collision. `RegistryGem` gains **`installable: boolean`** (true =
registry, false = DB-shared). The 5-minute TTL cache stays for the registry-index
fetch; the DB read is cheap and live. `mapIndexToGems` sets `installable:true`; the
DB mapper sets `installable:false`. Marketplace shows an install button only when
`installable`.

## Data flow

```
Connect (once):
  console UI → POST /api/explore/connect/start (local) → GitHub device code
  console UI → POST /api/explore/connect/finish (local)
       → deviceFlow token → sign(bindPayload) → POST api.agentgem.ai/api/aggregator/bind
       → accountBindings[pubkey] = @login   (production DB)

Share:
  console UI → POST /api/explore/share (local)
       → read workspace manifest → sign(manifestPayload)
       → POST api.agentgem.ai/api/aggregator/catalog
            → verify sig → bindings lookup → upsert producer + catalog_gems (publishedBy=@login)
       → mint share-card (/share/:id)
       → { exploreRef, version, shareUrl }

Browse:
  app.agentgem.ai → GET api.agentgem.ai/api/registry/gems
       → merge(catalog_gems, registry index) → RegistryGem[] with installable flag
```

## Error handling

The originating 500 becomes specific and actionable:

- not connected / no binding → **403** "connect your GitHub account first"
- producer not yet registered → typed error → "share once first" (or auto-resolved
  by the producer upsert on the hosted share endpoint)
- aggregator unreachable → **502** with a clear message
- bad signature / stale → **400**

`PublishToExplore.tsx` already surfaces `err.body`, so the real message shows in the
UI. The Share button is disabled until `GET /api/explore/identity` reports connected.

## Testing

- `catalogSigningPayload` round-trip; signature verify + binding-lookup rejection
  paths (reuse `binding.test` patterns): no-binding → 403, bad sig → 400, stale.
- `catalog_gems` upsert (insert + version overwrite); producer upsert on first share.
- Read merge in `publicCatalog`: DB-only, registry-only, and collision (DB wins);
  `installable` flag set correctly on both sources.
- Share proxy signs the exact canonical payload it forwards (spy on the http seam).
- Connect: `start` returns a device code; `finish` happy path writes binding.json;
  `unknown-producer` / `stale` surface typed errors.
- Component: `PublishToExplore` (→ Share) renders connect-gate when disconnected,
  enabled + submits when connected.

## Phasing

- **Phase 1** — Connect GitHub (device flow) in the console + binding. Ships the
  `identity` / `connect` endpoints, the UI control, and the producer-upsert
  resolution for first-time users. Independently verifiable via the binding row.
- **Phase 2** — DB catalog: `catalog_gems`, hosted `/api/aggregator/catalog`,
  console `/api/explore/share`, read merge, `installable` flag. Depends on Phase 1.

Registry publish is untouched throughout — this adds a path, never removes one.

## Out of scope

- Installable DB gems (storing archive bytes) — a later "share → promote to
  installable" step if wanted.
- Moderation / takedown UI, edit/unshare, version-history browsing.
- Replacing registry publish.
- Per-account API keys (the producer-key binding covers attribution).
