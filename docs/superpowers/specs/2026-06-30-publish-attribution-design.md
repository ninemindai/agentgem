# Account-Bound Publishing — Attribution (Gem Contributions #4a) — Design

**Date:** 2026-06-30
**Status:** Approved-pending-review — the attribution half of subsystem #4 of the [Gem Contributions vision](2026-06-30-gem-contributions-vision-design.md)

## Goal

Make publishes **accountable**: when a publish carries an authenticated M2-A web session, stamp a **server-verified `publishedBy`** (the session's GitHub login) on the registry discovery block. The local/trusted path (no session — your own machine/server token) and the agent MCP path are unchanged. Backend only. Scope-ownership **enforcement** is explicitly deferred (#4b) — see Non-goals.

## Context (ground-truth)

- **The constraint that set this scope:** the M2-A session stores only an opaque `tokenHash` (`packages/aggregator/src/webAuth.ts`) — the GitHub `access_token` is exchanged at OAuth (`src/auth/install.ts:108`) and **not persisted**. So a GitHub org-membership check at publish is infeasible, and the live gem is **org-scoped** (`@ninemind/...`), which pure login-as-scope would wrongly block. → enforcement is deferred; this slice does **attribution only** (no scope model decision, no GitHub-token dependency).
- `resolveSession(db, token)` → `{ login, avatarUrl, accountId } | null` (`webAuth.ts`). `accountId` is the internal `accounts.id` UUID; `login` is the GitHub handle (mutable but the right *display* attribution at publish time).
- `SESSION_COOKIE = "ag_session"` + `parseCookies(header)` live in `src/auth/cookie.ts`.
- **The injection seam (no migration needed):** `registerDrizzle(app, db)` binds the AppDb to the container under `DrizzleBindings.CLIENT` (singleton); `RestBindings.HTTP_REQUEST` is an injectable request seam (`@inject(RestBindings.HTTP_REQUEST, {optional: true}) req?`). #3 proved `GemController` is container-resolved **per request**, so the existing `registryPublish` handler can inject the request + db; `new GemController()` (tests) leaves them undefined → no session → publishes exactly as today.
- The publish core: `publishGem(args)` → `buildDiscovery(gem, scope, opts)` → `RegistryItemDiscovery` (`packages/distribute/src/registry.ts`). `author` is the free-form caller-supplied `scope` (unverified). `publishedBy` is a NEW, server-verified field — distinct.
- Two publish callers: `POST /api/registry/publish` (`src/gem.controller.ts`, the session-aware path) and the `registry_publish` MCP tool (`src/gem.tools.ts`, agent-internal, no session — unchanged).

## Decisions (settled in brainstorming)

- **Attribution only** — stamp `publishedBy`; do NOT enforce scope ownership (deferred to #4b, which needs the scope model + a token strategy).
- **`publishedBy` is server-verified, never caller-supplied** — it comes from the resolved session, so it can't be spoofed (unlike `author`/`scope`). Shape: `publishedBy?: string` (the verified GitHub `login`). Login-only (not the internal UUID) — public-meaningful, no internal-id leak into the public registry; the rename caveat is acceptable for a v1 attribution stamp (it records who published at that time).
- **In-place controller injection, not endpoint migration** — lower blast radius; builds on #3's controller-injection. Session-optional: present → stamp; absent → unchanged.
- **MCP tool unchanged** — agent-internal, no session → no `publishedBy`.

## Architecture & data flow

```
POST /api/registry/publish  (GemController.registryPublish — session-aware)
  req  = @inject(RestBindings.HTTP_REQUEST, {optional:true})   // undefined in tests
  db   = @inject(DrizzleBindings.CLIENT, {optional:true})       // undefined in tests
  publishedBy = await resolvePublishedBy(req, db)               // login | undefined
  publishGem({ ...existing args..., publishedBy })

resolvePublishedBy(req, db):
  if !req || !db → undefined
  token = parseCookies(req.headers.cookie)[SESSION_COOKIE]
  if !token → undefined
  who = await resolveSession(db, token)
  return who?.login            // verified GitHub login, or undefined

publishGem / buildDiscovery (distribute, pure):
  buildDiscovery(gem, scope, { ..., publishedBy }) → discovery.publishedBy = publishedBy (if set)
```

`new GemController()` (every existing controller test) → `req`/`db` undefined → `resolvePublishedBy` → undefined → `publishGem` called exactly as before. **No existing test changes.**

## Components (files)

- **`packages/distribute/src/registry.ts`** (pure) — add `publishedBy?: string` to `RegistryItemDiscovery`; add `publishedBy?` to `buildDiscovery`'s `opts` (`if (opts.publishedBy) d.publishedBy = opts.publishedBy;`); add `publishedBy?` to `publishGem`'s args, passed into the inner `buildDiscovery` call. (Same additive pattern as the `type` field in #3.)
- **`src/registry/publishedBy.ts`** (new) — `resolvePublishedBy(req: Request | undefined, db: AppDb | undefined): Promise<string | undefined>` (parseCookies + `SESSION_COOKIE` + `resolveSession`). Pure-ish (I/O only via the injected db); the single tested seam. Imports `parseCookies`/`SESSION_COOKIE` (`../auth/cookie.js`), `resolveSession` (`@agentgem/aggregator`), types only for `Request`/`AppDb`.
- **`src/gem.controller.ts`** — extend the `GemController` constructor (already injects `@service(GemTypeRegistry)` from #3) with `@inject(RestBindings.HTTP_REQUEST, { optional: true }) private req?: Request` and `@inject(DrizzleBindings.CLIENT, { optional: true }) private db?: AppDb`. In `registryPublish`, compute `const publishedBy = await resolvePublishedBy(this.req, this.db);` and add `publishedBy` to the `publishGem({...})` call. (`@inject`, `RestBindings`, `DrizzleBindings` import sources confirmed in `@agentback/{core,rest,drizzle}`.)
- **`src/gem/publicCatalog.ts`** — surface `publishedBy` on `RegistryGem` + `mapIndexToGems` (`publishedBy: item.discovery?.publishedBy`), so a future UI can show "published by @x". Thin/additive.

## Testing

- **`buildDiscovery`/`publishGem` (distribute):** `opts.publishedBy` lands on `discovery.publishedBy`; absent → no key (additive). (Extend `src/gem/__tests__/registryPublish.test.ts`.)
- **`resolvePublishedBy` (the seam):** mirror `src/aggregator/__tests__/webAuth.test.ts` (makeTestDb / PGlite) — insert an account + a webSession; a fake `req` carrying `Cookie: ag_session=<token>` → resolves to the account's `login`; no cookie / no session / `req`/`db` undefined → `undefined`; an expired/invalid token → `undefined`.
- **`mapIndexToGems`:** surfaces `publishedBy` on `RegistryGem`.
- **No-regression:** the existing `gem.controller.test.js` (`new GemController()` publish path) stays green — the added optional injects default to undefined.
- Gates: `pnpm test` (compiled dist) incl. the new seam + distribute tests.

## Non-goals (explicitly deferred to #4b / later)

- **Scope-ownership enforcement** (a user may only publish scopes they own) — needs the scope model (login-as-scope / claimed-scopes / org-membership) + a GitHub-token strategy (the session doesn't store one). Build when there's a publish-from-marketplace UI to consume it.
- The publish-from-marketplace UI itself.
- Stamping the stable GitHub numeric id (would need `resolveSession` to also return `providerAccountId`); login-only is the v1.
- A "gems by @you" listing / authorship search.

## Risks

- **Request-scoped injection into a constructor** — `@inject(RestBindings.HTTP_REQUEST, {optional:true})` in the controller constructor is novel here (#3 added `@service`; this adds the request seam). The framework documents this exact pattern; verified `GemController` is per-request-resolved. The optional default keeps `new GemController()` working. Mitigation: the `resolvePublishedBy` seam is unit-tested independently of the controller, so the wiring risk is isolated.
- **Login mutability** — `publishedBy` records the login at publish time; a later GitHub rename won't update it. Acceptable for v1 attribution; the stable-id upgrade is a noted non-goal.
- **No live consumer yet** — the marketplace is read-only, so this is groundwork (the user accepted this when choosing #4). The tests are the exerciser; correctness is the deliverable.
- **Hot files** — `registry.ts`, `gem.controller.ts`, `publicCatalog.ts` are concurrently active; additive diffs, branch off latest `origin/main`, integrate promptly.
