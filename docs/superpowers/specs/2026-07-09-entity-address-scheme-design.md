# Entity address scheme

**Date:** 2026-07-09
**Status:** Approved design, ready for planning
**Branch:** `docs/entity-address-scheme`

## Problem

You cannot copy a link to a mini-game. Opening one from the `/minigames` grid mounts a
fullscreen React portal (`GamePreview.tsx` portals a `GamePlayer` to `document.body`); the
URL never changes, so the address bar has nothing to copy. A published game *is* reachable
at `/gems/:key`, but that is a gem detail page, not a game.

The narrow fix — add a route — invites the general question: which things in AgentGem have
addresses at all? The answer today is inconsistent, and the two apps have **inverted gaps**:

| | Addressable today | Rendered, not addressable |
|---|---|---|
| **Marketplace** (path routes, `Router.tsx`) | gems `/gems/:key`, ingredients, catalog skills, profiles, orgs | **games** |
| **Console** (hash routes, `Shell.tsx`) | sessions `#/sessions/:agent/:sessionId` (+`?turn`, `?vs`), setup artifacts `#/setup/:tab?a=:name` | **a gem has no detail route at all**; Recall's query; Watch's selection |

The marketplace addresses entities and forgot games. The console addresses *panels* and
mostly forgot entities.

The blocker is not routing. It is that **there is no unified name for an entity.** Three
identifier schemes coexist and none spans the set:

1. registry refs — `@scope/name@^1.2.3` (`packages/distribute/src/registry.ts`)
2. content digests — `sha256:<hex>` / `gemDigest`
3. the `agentgem://` deep link — whose `ROUTES` allowlist (`desktop/src/deeplink.ts:13`)
   admits exactly two of the console's ~28 routes

Artifacts are named *within* a gem; sessions are a composite `(agent, sessionId)`. You cannot
render a URL for a thing you cannot name.

## Goal

Make it easy to **copy a link in the browser and share it**. A stranger with no account, no
install, and no console opens that link and the mini-game is already running.

Achieve it by writing down the entity address scheme the codebase has already half-adopted,
then making games its first conformer.

### Non-goals

- **Shareable console URLs.** `localhost:4317/#/…` names a process on your laptop. Console
  routes serve *resumability*, which is a different feature; it gets its own spec.
- **View state as entities.** Recall's query and Watch's selection deserve query params
  (`#/recall?q=…`), not entries in the entity catalog. Calling view state an entity is how
  these schemes bloat.
- **Workflow panels as entities.** Rubrics, Dreaming, Benchmark, Optimize, Materialize,
  Deploy. The test that earns an address is: *can you meaningfully send someone to this exact
  thing, or return to it yourself?*
- **`og:image`.** Links unfurl as a `summary` card (title + description), like the existing
  `kind:"gem"` share card. No poster, no `@resvg/resvg-wasm`, no rasterizer.
- **Live-updating links.** See *Immutable links* below.

## Addressable ≠ shareable (crux)

An entity does not have "its own URL." It has up to **three addresses**, and they are not
interchangeable:

| Space | Prefix | Property |
|---|---|---|
| Local | `localhost:4317/#/` | Bookmarkable, resumable. **Never shareable.** |
| Public | `app.agentgem.ai/` | Shareable — but only once the entity is *hosted*. |
| Protocol | `agentgem://` | The bridge letting a public link reach back into a local console. |

The invariant is therefore not "one URL per entity" but: **one canonical entity path, which
renders into whichever address spaces apply to it.**

Only the *public* space serves the stated goal. A session is perfectly addressable and
entirely unshareable. This spec defines all three, but only the public space has conformers
in the roadmap below.

## The scheme

### Canonical form

A canonical entity path is `<plural-collection>/<entity-id>`, rendered by prefix:

```
canonical    gems/@acme/tetris
console      localhost:4317/#/gems/@acme/tetris
marketplace  app.agentgem.ai/gems/@acme/tetris
protocol     agentgem://gems/@acme/tetris
```

Plural is not a preference — both apps independently converged on it
(`#/sessions/claude/abc123`, `/gems/@scope/name`). Writing it down costs no renames for those
routes. The apparent `/gems` vs `/gems/:key` ambiguity is already resolved by match order
(entity before collection) in `Router.tsx`, and by longest-prefix matching in
`Shell.tsx:78-85`. **Both apps already implement the rule; neither has stated it.**

### Rule 1 — ids are scoped, so unlisted is unlistable by construction

A published gem key is `scope/name` and always contains a `/` (`@acme/tetris`,
`raymondfeng/miniapp`). The `@` prefix is optional and inconsistent across mint paths —
`gem.controller.ts`'s `publishSetup` builds `${scope}/${name}`, while
`distribute/src/registry.ts` builds `"@" + scope + "/" + name` — so the `/` is the real
discriminator, not the `@`. The charset isn't guaranteed either: `recordCatalogShare`
(`packages/aggregator/src/catalog.ts`) writes `gemKey` into `catalog_gems` with no charset
validation — only signature, freshness, and binding checks. `[a-z0-9-]` is enforced solely by
the separate CLI path (`registry.ts`'s `parseRef`), which production publishing does not go
through. An unlisted share is therefore a **slash-less key** — `xK3f9a2Bq1`, from
`genShareId()` — and it *cannot* be listed, because listing means writing a key containing `/`
into `catalog_gems`, and `genShareId()`'s output never does. The invariant is enforced by the
slash alone, not by remembering to skip a write.

This makes unlisted-ness a property of the id *shape*: PR 2 must verify at `genShareId()`'s
mint site that a generated share id can never match `isPublishedKey` — ideally with a test
asserting exactly that.

### Rule 2 — nesting expresses containment

An artifact lives in a gem, so it addresses as `gems/@acme/tetris/skills/build`.

This is the one route the scheme genuinely asks us to change. The console's
`#/setup/skills?a=build` addresses an artifact by a *query param hanging off a panel* and so
cannot distinguish **your local `build` skill** from **`@acme/tetris`'s `build` skill**. They
are different entities. Local, gem-less artifacts get a new top-level collection:
`workspace/skills/build`.

### The catalog

`—` = the entity meaningfully has no address in that space. Otherwise: *exists* = works
today; *new* = the scheme declares it, nothing builds it yet; *rename* = exists under a
non-conforming path.

| Entity | Canonical path | Local | Public | Protocol |
|---|---|---|---|---|
| Gem | `gems/@acme/tetris` | *new* | *exists* | *new* |
| Gem artifact | `gems/@acme/tetris/skills/build` | *new* | *new* | *new* |
| Game | `games/@acme/tetris` | *new* | *new* | *exists* (as `play`) |
| Unlisted game | `games/xK3f9a2Bq1` | — | *new* | *new* |
| Session | `sessions/claude/abc123` | *exists* | — | *new* |
| Workspace artifact | `workspace/skills/build` | *new* | — | *new* |
| Profile | `@login` | — | *exists* | — |
| Org | `orgs/acme` | — | *exists* | — |
| Ingredient | `ingredients/:id` | — | *rename* | — |
| Catalog skill | `skills/:sourceId/:path` | — | *rename* | — |

Every `*new*` in the **Protocol** column additionally requires widening
`desktop/src/deeplink.ts`'s `ROUTES` allowlist, which today admits only `get-gems` and `play`.
That allowlist is a deliberate security control — a crafted `agentgem://` URL can only reach
vetted panels — so widening it is its own scoped change, declared here and built later.

Two entries carry decisions rather than facts:

- **`games/<key>` is a presentation alias, not a distinct entity.** A game *is* a gem whose
  sole artifact is a `game` — `saveMiniapp` already dual-writes exactly that
  (`packages/play/src/miniapps.ts`, `writeGameGem`). The spec says so plainly rather than
  minting a second entity kind.
- **`@login` and `orgs/…` do not fit `<plural>/<id>`.** They are pre-existing, public, and
  linked. They are declared exceptions, not violations.

### What the scheme deleted

Two pieces of machinery from the pre-scheme design turned out not to exist:

- **A second route.** We had settled on `/play/:id` (unlisted) *and* `/minigames/:key`
  (published). Under `games/<key>` with Rule 1, they are **one route** whose parameter is
  either a registry key or a share id. Both resolve through the same
  `GET /api/aggregator/game-html?key=&version=`.
- **A table variant.** With the share id *being* the gem key, there is no opaque-id →
  `(gemKey, version)` indirection to store: no `share_cards` row, no `kind:"miniapp"`, no
  `payload jsonb` widening. `gem_archives` holds the bytes; `game-meta` unpacks the archive for
  a title. (PR 2 does add **one** `gem_archives` column — `owner_account_id`, for revoke
  ownership — via the idempotent `add column if not exists` pattern; see *Minting*. That is the
  scheme's only schema touch, and it's an addition, not a variant.)

## Minting a public address (the only new mechanism)

Everything else in this spec is routing. A locally-authored miniapp has no public address
because its bytes are in `~/.agentgem/miniapps/`. Minting uploads the archive and returns a
key.

```
POST /api/aggregator/share-archive
  body    { manifest, archiveBase64, pubkey, signedAt, signature }   # mirrors PublishGemBody
  server  accountId = resolveSignedAccount(pubkey, signedAt, signature)  # else 401/not-connected
          importGem(bytes)                     # verifies gem.lock, throws -> 400
          manifest.gemDigest === digest        # else 400 digest-mismatch
          staticGate(html)                     # re-run server-side on any game artifact
          key = genShareId()                   # slash-less => unlistable (Rule 1)
          upsertGemArchive(key, "1", bytes)     # NEW column: owner_account_id = accountId
          # deliberately NO recordCatalogShare (no catalog row => unlisted)
  returns { key, url: "https://app.agentgem.ai/games/xK3f9a2Bq1" }

DELETE /api/aggregator/share-archive?key=
  body    { pubkey, signedAt, signature }       # signature over the shareId
  server  accountId = resolveSignedAccount(pubkey, signedAt, signature)  # else 401
          row = gem_archives[key]               # 404 if absent
          row.owner_account_id != null && row.owner_account_id === accountId  # else 403 forbidden
          delete gem_archives[key]              # fail-closed on NULL owner
```

Four load-bearing properties:

- **Ownership conforms to the identity re-key (already merged, PR #285).** A share is owned by
  an **`accounts.id` UUID** (== better-auth `"user".id`) — the authorizing "user id", never the
  device key and never a login string. `resolveSignedAccount` is the `recordCatalogShare` chain
  extracted into a reusable helper: `verify(pubkey, payload, signature)` + ±300s freshness +
  `account_bindings → accounts.id`. The revoke check copies `deleteCatalogGem` verbatim —
  UUID `===`, and **a NULL owner is owned by nobody, fail closed** (the invariant the re-key
  exists to protect; never a string-compare fallback). Revoke therefore works from **any device
  bound to the owning account**, not just the minting one.
- **Light-share requires a connected identity.** An unconnected device resolves to no
  `accounts.id`, so it cannot own — and an unowned share is un-revokable by construction. Light
  share is lighter than *publish* (no scope, no catalog row, no listing) but not lighter than
  *signed-in*. The console shows a connect prompt when `!identity.bound`.
- **One schema change.** `gem_archives` gains a nullable `owner_account_id uuid references
  accounts(id)` column + index, via the established `ensureSchema` `alter table ... add column
  if not exists` idempotent pattern (copy the `catalog_gems.owner_account_id` block). This is
  PR 2's departure from PR 1's zero-schema-change property: revoke ownership genuinely needs a
  place to record the owner.
- **`staticGate` runs server-side.** `gameGate.ts:3-10` says in its own header that the gate
  is not a security boundary — the sealed null-origin `sandbox="allow-scripts"` iframe with
  `default-src 'none'` (`GamePlayer.tsx`, `sealedDoc`) is. But we serve attacker-authored HTML
  from our origin, and client-side gating is not gating. `staticGate` is the cheap
  regex+tokenizer half; jsdom's `gameGate` is not re-run.

### The version-resolution fallback (a PR 1 seam this fixes)

`game-meta` resolves a bare key's version through `latestGemVersion`, which reads `catalog_gems`
— and a scope-less share id has **no catalog row**, so it returns `null` and the `/games/<id>`
link 404s. PR 2 must make version-resolution fall back to `gem_archives` for unlisted keys: a
share has exactly one `(shareId, "1")` archive row, so resolve to it directly when the catalog
yields nothing. Without this, the share link does not work at all.

### Revocation

An unlisted URL is a capability: unguessable, permanent. Standing up public hosting of
user-authored HTML with no takedown path is not acceptable, and revocation is awkward to
retrofit once links are in the wild. The signed revoke route ships in the same PR as the mint
(server: PR 2a), with a "Revoke link" affordance beside "Copy link" (console: PR 2b). Because
ownership is the account UUID, revoke succeeds from any of the owner's connected devices and
fails closed for everyone else.

**Durable revoke (PR 2b).** Revoke's purpose is a *later, different session* takedown, so the
console must remember which miniapps are shared. Each shared miniapp persists its shareId in a
**sidecar `share.json`** in its registry dir — NOT in `MiniappMeta`/`meta.json`, which
`writeGameGem` bakes into the shared gem and which `saveMiniapp` reconstructs field-by-field
(the id would leak into the gem and be dropped on re-save). The console's miniapp read surfaces
the sidecar so the Play panel shows a persistent "Shared · Copy · Revoke" state across restarts.
The light "Copy share link" button is distinct from the heavy "Share to app.agentgem.ai"
publish button, and reuses Studio's existing `pendingPublish`/`ConnectGitHub` bind-resume for
the connect-when-unbound path (light-share still requires a connected identity — an unconnected
device owns nothing).

### Immutable links

`gem_archives` is PK `(gem_key, version)`. Re-sharing an edited miniapp **mints a new key**;
the old link keeps serving the old game. The alternative — bumping the version under a stable
key — makes shared links live-update under the recipient, which is a footgun rather than a
feature. New-key-per-share matches how `sha256:`-pinned digests already behave in this
codebase.

## Enforcement

A doc decays; a test does not. `entityPath.ts` exports the declared collections plus the
canonical path builders and parsers — it is the artifact that makes this a scheme rather than a
naming convention.

**It has two homes, on purpose.**

`packages/model/src/entityPath.ts` already exists on `origin/main` — the deferred-inventory work
(`?body=defer`) conformed to this scheme first, while it was still an unmerged draft, and
implements the `workspace/*` collections. Its header states the norm this spec adopts: *"other
collections get added by whoever conforms them next, rather than shipping builders with no
caller."*

The marketplace cannot import it. It is deliberately dependency-isolated — zero workspace
dependencies, no `references` in its `tsconfig.json` — and `gems/cuts.ts:1-2` says so outright:
*"mirrored from the server's GEM_TYPES for the marketplace (which can't import
`@agentgem/model`)"*. `@agentgem/model` also pulls in `yaml`.

So the game builders live at **`packages/marketplace/src/entityPath.ts`**, their only consumer.
The server's `game-meta` returns `{title, genre, version}` and never builds a path. **The two
files share the scheme, not a single function** — `workspace/*` builders have no marketplace
caller and `games/*` builders have no server caller — so there is nothing to drift and no mirror
to guard. If a future change gives one of them a caller on the other side, promote that function
then, via the `cuts.ts` mirror-plus-drift-guard precedent.

**Deviation — game paths are not percent-encoded.** `workspaceArtifactPath` encodes every
segment because artifact names carry `/` as *data* (`codex:rules/default.rules`). A gem key
carries `/` as *structure* — the `@` is optional and the charset is unvalidated, but the key's
slashes are always structure, never data. Encoding would yield `/games/%40acme%2Ftetris`, and a
copy-friendly link is this spec's entire goal. `games/<key>` is therefore emitted raw and parsed
greedily. The parser still decodes, so a hand-edited or legacy encoded link resolves.

The marketplace gets a **router conformance test**: every registered route must be either a
declared collection, a well-formed entity path, or a route explicitly listed as a panel. A new
route that invents its own shape fails the test.

**"Fails CI" requires wiring.** The marketplace's jsdom suite is not in CI today (root
`pnpm test` globs only `dist/**/__tests__` + `website/edge/**`); it runs via a local
`--filter`. So PR 3b adds a `pnpm --filter @agentgem/marketplace test` step to `ci.yml` — the
first CI coverage of the user-facing marketplace — so the conformance test actually gates. The
suite is green today (38 files / 256 tests), so the wiring lands clean.

## Files

- `packages/marketplace/src/entityPath.ts` *(new)* — collections, builders, parsers. See
  *Enforcement* for why not `packages/model`.
- `packages/marketplace/src/Router.tsx` — add `/games/:key`; plural canonical forms for
  `/ingredient/:id` and `/skill/:sourceId/*path`, keeping the singular forms as matching
  aliases that `replaceState` to canonical (no redirect infrastructure needed).
- `packages/marketplace/src/pages/Play.tsx` *(new)* — resolves `key` → `game-html`, mounts
  `GamePlayer` fullscreen immediately.
- `packages/marketplace/src/pages/Minigames.tsx` — the grid's fullscreen portal calls
  `navigate()`, so the URL appears in the address bar while you play. *This is the fix for the
  original complaint.*
- `packages/marketplace/src/worker.ts` *(new, PR 3a)* + `wrangler.jsonc` — `main` +
  `assets.binding` + `run_worker_first` + `vars.AGGREGATOR_API`, copying
  `website/edge/wrangler.toml` (the only existing `main` + `assets` pattern in the repo). For a
  `GET /games/<key>`, fetches `${AGGREGATOR_API}/api/aggregator/game-meta?key=`, and on success
  injects `og:title`/`og:description` + a `twitter:card=summary` (NO `og:image`) into the SPA
  shell's `<head>` (mirroring `share.js`'s `renderGemShareHtml` + its `esc()`), then serves the
  full SPA body so React still hydrates and plays. **On ANY failure — no `AGGREGATOR_API`, a
  non-2xx `game-meta`, a fetch throw — serves `env.ASSETS.fetch(request)` unmodified.** Every
  non-games request passes straight through to `env.ASSETS`. Because `run_worker_first` runs the
  worker on every hit, this degradation is load-bearing: a worker bug or API blip must never take
  down `app.agentgem.ai`.
- `src/aggregator.controller.ts` — `POST`/`DELETE /share-archive`; `GET /game-meta?key=` →
  `{ title, genre, version }`, used by both the Worker (for OG) and `Play.tsx` (for a title
  while HTML loads). It is the one genuinely new read route.
- `src/originGuard.ts` — add `/api/aggregator/game-meta` to `PUBLIC_READ_PATHS`. Exact match,
  no prefix.
- `packages/console/src/panels/Play/` — "Copy share link" and "Revoke link".

## Error handling

| Condition | Behavior |
|---|---|
| Unknown/revoked key | `game_archive_not_found`; `Play.tsx` renders a "this link doesn't exist" state, not a blank iframe |
| Key resolves, gem has no `game` artifact | existing `not_a_game` 404 |
| Upload fails `staticGate` | `400`, surfacing the gate's own failure reason |
| Worker cannot reach the API | serve `index.html` unmodified — link works, unfurls generically |
| Title contains `"` or `<` | Worker escapes on injection; server sanitizes 1–120 chars inbound. The Worker does not trust the server. |

## Testing

Concentrated on the claims that would silently rot:

- **The unlisted invariant** — after `share-archive`, the key contains no `@` and does not
  appear in `GET /api/registry/gems`. This protects the deliberate `recordCatalogShare`
  omission from a future refactor quietly re-listing everything.
- Server-side `staticGate` rejects HTML containing `fetch()`, even though the client gates it.
- Revoke: `DELETE`, then `game-html` → 404.
- CORS: `game-meta` answers a cross-origin `OPTIONS` preflight. (Console and `curl` both pass
  when this is broken; only a cross-origin browser fetch fails.)
- Worker: OG injected for `/games/:key`; a title containing `"` is escaped; `/assets/*` passes
  through untouched; API-down serves unmodified `index.html`.
- Legacy `/ingredient/:id` still matches and rewrites to canonical.
- `entityPath` parse/format round-trip; router conformance for both apps.

## Sequencing

Three PRs, **each branched off freshly-fetched `origin/main`**. Per `CLAUDE.md`, one PR = one
settled scope; commits appended to an already-merged PR's branch are silently dropped from the
trunk (this has bitten multi-commit PRs here twice).

1. **MERGED (#287).** `entityPath.ts` + `/games/:key` + `Play.tsx` + grid `navigate()` +
   `game-meta`. Copyable links for published games. No Worker, no new storage, no upload path.
2. **MERGED (2a #304, 2b #330).** `share-archive` mint + revoke (server) + console Copy/Revoke.
   Links for locally-authored miniapps.
3. **Split — the OG Worker is deploy-risky (`run_worker_first` fronts ALL app.agentgem.ai
   traffic), the renames are SPA-only.** So:
   - **3a** — the OG-unfurl Worker alone (`worker.ts` + `wrangler.jsonc`: `main`,
     `assets.binding`, `run_worker_first`, `vars.AGGREGATOR_API`). Lands + deploys in isolation,
     watchable/rollback-able on its own.
   - **3b** — plural renames of `/ingredient`→`/ingredients` and `/skill`→`/skills` (update the
     link generators; keep the singular forms as aliases that `replaceState` to canonical) +
     the router conformance test + wiring the marketplace suite into CI.

Console entity routes (`#/gems/:key`, `workspace/…` replacing `#/setup/:tab?a=`) are real
value but serve resumability, not sharing. They get their own spec after this one.

### Verification notes

- `packages/console` tests are not in CI — PR 2 gets a local
  `pnpm -C packages/console exec vitest` run.
- After each merge, grep `origin/main` for a marker from **every** commit, not just the first.

## Related

- `docs/proposals/gem-composition-resolution.md` — recommends removing `ArtifactRef.kind:
  "gem"` (the `sha256:` content-addressed arm; `resolveArtifactRef` returns "not implemented
  yet" and nothing calls it). That decision is **compatible** with this scheme: an address
  scheme wants stable *names*, not digests. It should be made knowing this spec exists, not
  separately.
