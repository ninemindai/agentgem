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

A published gem key begins with `@` (`@acme/tetris`). Nothing else does. An unlisted share is
therefore a **scope-less key** — `xK3f9a2Bq1` — and it *cannot* be listed, because
`catalog_gems` requires `@scope/name` (`registry.ts:31-41` validates scope/name as
`[a-z0-9-]`). The invariant is enforced by a format the registry already validates, not by
remembering to skip a write.

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
  `(gemKey, version)` indirection to store. No `share_cards` row, no `kind:"miniapp"`, no
  `payload jsonb` widening, **no schema change** — and so no
  `ensureSchema`-add-column-if-not-exists drift risk. `gem_archives` holds the bytes;
  `game-meta` unpacks the archive for a title.

## Minting a public address (the only new mechanism)

Everything else in this spec is routing. A locally-authored miniapp has no public address
because its bytes are in `~/.agentgem/miniapps/`. Minting uploads the archive and returns a
key.

```
POST /api/aggregator/share-archive
  body    { manifest, archiveBase64, pubkey, signedAt, signature }   # mirrors PublishGemBody
  server  importGem(bytes)                     # verifies gem.lock, throws -> 400
          manifest.gemDigest === digest        # else 400 digest-mismatch
          staticGate(html)                     # re-run server-side on any game artifact
          key = genShareId()                   # scope-less => unlistable (Rule 1)
                                               # today lives in src/share/shareStore.ts,
                                               # whose share_cards path this design retires;
                                               # move it beside upsertGemArchive
          upsertGemArchive(key, "1", bytes)
          # deliberately NO recordCatalogShare
  returns { key, url: "https://app.agentgem.ai/games/xK3f9a2Bq1" }

DELETE /api/aggregator/share-archive?key=      # same signature gate; revokes the link
```

Three load-bearing properties:

- **The route is generic.** It hosts *an archive*, unlisted. Games are its first caller; an
  unlisted gem share is the same operation with a `/gems/<id>` URL. Naming it `share-miniapp`
  would freeze the scheme's first conformer into its permanent shape.
- **`staticGate` runs server-side.** `gameGate.ts:3-10` says in its own header that the gate
  is not a security boundary — the sealed null-origin `sandbox="allow-scripts"` iframe with
  `default-src 'none'` (`GamePlayer.tsx`, `sealedDoc`) is. But we serve attacker-authored HTML
  from our origin, and client-side gating is not gating. `staticGate` is the cheap
  regex+tokenizer half; jsdom's `gameGate` is not re-run.
- **Reads need nothing new.** `GET /api/aggregator/game-html?key=&version=` is already in
  `PUBLIC_READ_PATHS` (`src/originGuard.ts:36`) with `Access-Control-Allow-Origin: *`. A
  scope-less key flows through it unchanged.

### Revocation

An unlisted URL is a capability: unguessable, permanent, unauthenticated. Standing up public
hosting of user-authored HTML with no takedown path is not acceptable, and revocation is
awkward to retrofit once links are in the wild. `DELETE /api/aggregator/share-archive` ships
in the same PR as the mint, with a "Revoke link" affordance beside "Copy link."

### Immutable links

`gem_archives` is PK `(gem_key, version)`. Re-sharing an edited miniapp **mints a new key**;
the old link keeps serving the old game. The alternative — bumping the version under a stable
key — makes shared links live-update under the recipient, which is a footgun rather than a
feature. New-key-per-share matches how `sha256:`-pinned digests already behave in this
codebase.

## Enforcement

A doc decays; a test does not.

`packages/model/src/entityPath.ts` (new) exports the declared collections plus the canonical
path builders and parsers. Both apps import it — it is the artifact that makes this a scheme
rather than a naming convention.

Each app gets a **router conformance test**: every registered route must be either a declared
collection, a well-formed entity path, or a route explicitly listed as a panel. A new route
that invents its own shape fails CI.

## Files

- `packages/model/src/entityPath.ts` *(new)* — collections, builders, parsers.
- `packages/marketplace/src/Router.tsx` — add `/games/:key`; plural canonical forms for
  `/ingredient/:id` and `/skill/:sourceId/*path`, keeping the singular forms as matching
  aliases that `replaceState` to canonical (no redirect infrastructure needed).
- `packages/marketplace/src/pages/Play.tsx` *(new)* — resolves `key` → `game-html`, mounts
  `GamePlayer` fullscreen immediately.
- `packages/marketplace/src/pages/Minigames.tsx` — the grid's fullscreen portal calls
  `navigate()`, so the URL appears in the address bar while you play. *This is the fix for the
  original complaint.*
- `packages/marketplace/src/worker.js` *(new)* + `wrangler.jsonc` — `main` +
  `assets.binding` + `run_worker_first`, copying `website/edge/wrangler.toml` (the only
  existing `main` + `assets` pattern in the repo). Injects OG title/description. **On API
  failure, serves `index.html` unmodified** — an API blip must never take down the play
  surface. Mirrors `share.js`'s `placeholderHtml()` degradation.
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

1. `entityPath.ts` + `/games/:key` + `Play.tsx` + grid `navigate()` + `game-meta`.
   **Ships copyable links for published games.** No Worker, no new storage, no upload path.
2. `share-archive` mint + revoke + console Copy/Revoke.
   **Ships links for locally-authored miniapps.**
3. Worker OG injection + plural renames with aliases.

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
