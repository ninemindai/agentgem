# Public API → framework controllers (Fix 3)

**Date:** 2026-07-12
**Status:** Approved design
**Prerequisite:** Fix 1 (shared `publicCors` helper) — merged (PR #371).

## Goal

Kill the raw-express special case. Today ten public, cross-site API modules
(`stars`, `reviews`, `catalog/install`, `catalog/shares`, `groups`, `usage`,
`handles`, `account/install`, `githubApp/orgsApi`, `registry/uploadPublish`) are
mounted on raw express via `install*()` functions with hand-rolled session
resolution and CORS. Move them onto AgentBack framework controllers so there is
**one way to add a public route** — a controller method with `@authenticate` +
Zod schemas — and, as a side benefit, they appear in `/openapi.json`.

The driving payoff is architectural uniformity, not OpenAPI or schema-sharing.
Those follow for free but are not the reason.

## Non-goals

- **Not** migrating `auth/mount.ts` (better-auth's own `all('/*splat')` wildcard
  handler) or `account/connect.ts` (an OAuth callback with no CORS). Neither is a
  controller by nature; both stay raw express.
- **Not** unifying schemas across the server and the marketplace `packages/marketplace`
  package. Controllers get their own Zod schemas (like `GemController`); a future
  cross-package shared-schema move is out of scope.
- **Not** changing any observable behavior. Every migrated route must return
  byte-identical responses, status codes, and CORS headers.

## The three seams

### Seam A — Auth: a `better-auth-session` strategy

Add a custom `AuthenticationStrategy` (`src/auth/betterAuthSessionStrategy.ts`):

```ts
// name: "better-auth-session"
// authenticate(request): resolveSession(auth, headersFrom(request))
//   → { [securityId]: accountId, login } | undefined
```

It wraps the existing `resolveSession(auth, req.headers)` (which already reads
either a better-auth session cookie **or** an `Authorization: Bearer` token, so the
local-process usage-report path keeps working). Registered with `app.service()`.

Per-route auth mode:

- **Authed routes** (e.g. `POST /api/stars/toggle`): `@authenticate('better-auth-session')`.
  The framework's auth phase throws **401** when the strategy returns `undefined`,
  replacing each handler's `if (!accountId) 401` line.
- **Optional-auth routes** (e.g. `GET /api/stars` — public counts always, plus the
  caller's own `mine` when signed in): `@authenticate('better-auth-session', 'anonymous')`.
  The built-in `AnonymousAuthenticationStrategy` returns `ANONYMOUS_USER` when the
  session strategy yields nothing, so no 401; the handler branches on whether the
  principal is a real account.

The controller reads identity via `@inject(SecurityBindings.USER)`. A small
`realAccount(user)` helper returns the `accountId` or `null` when the principal is
`$anonymous`.

**New dependencies:** `@agentback/authentication`, `@agentback/security`,
`@agentback/authorization` (the authentication component depends on the latter two).
This is the cost of the goal and is accepted.

**Wiring** (once, in `createApp`): register the authentication component, the
`AnonymousAuthenticationStrategy`, and the `betterAuthSessionStrategy` (constructed
with the already-hoisted `auth` instance). The strategy only registers when `auth`
exists (same precondition as the `install*()` calls today).

### Seam B — CORS: one prefix-scoped middleware

The framework CORS config is a single global setting, but the server hosts two
route classes: loopback/console routes (`GemController` etc. — same-origin,
originGuard-gated, must **not** advertise credentialed CORS) and the public
cross-site routes. To keep the current posture exactly, `publicCors.ts` transforms
from a per-module helper into **one** app-level middleware:

```ts
// publicCorsMiddleware(webOrigins): for a request whose path matches a PUBLIC
// prefix, reflect an allow-listed Origin with Access-Control-Allow-Credentials,
// and short-circuit OPTIONS with the 204 preflight (methods derived from the
// route table). Non-public paths pass through untouched.
```

Mounted in the framework middleware chain (like `originGuard`) so it runs before
controller dispatch and answers preflight before dispatch is attempted. The public
prefix set is the same list originGuard already exempts (`/api/stars`,
`/api/reviews`, `/api/catalog/`, `/api/usage`, `/api/orgs/`, `/api/account/`,
`/api/handle`, `/api/registry/upload-publish`).

Preflight `Allow-Methods`/`Allow-Headers` per route are preserved from the current
values (captured in Fix 1): a small path→(methods,headers) table drives the OPTIONS
response so each route keeps its exact preflight. `Allow-Headers` stays
`content-type` except `groups`/`usage`/`orgs` which keep `content-type, authorization`.

The `cors()`/`preflight()` function exports used by the raw handlers are removed as
each module migrates; the middleware is the single remaining CORS surface.

### Seam C — originGuard: no change

`originGuard` (line 93) already `next()`s every one of these prefixes and runs as
framework middleware before dispatch, so controllers under them stay exempt with no
change. The one nuance: today originGuard `next()`s without setting CORS (the raw
handler set it); after migration the `publicCorsMiddleware` sets CORS. Ordering:
`publicCorsMiddleware` must run so that OPTIONS is answered for these prefixes.
originGuard passes OPTIONS for these prefixes through (it only short-circuits OPTIONS
for its own `PUBLIC_READ_PATHS`/`PUBLIC_WRITE_PATHS`), so the CORS middleware handles
them. Mount order is asserted by a test.

## Pilot: `StarsController`

Stars is the pilot because it exercises every hard case in one small module: an
optional-auth GET, a required-auth POST, and credentialed CORS.

```ts
@api({ basePath: "/api" })
export class StarsController {
  constructor(@inject(DrizzleBindings.CLIENT) private db: AppDb) {}

  @authenticate("better-auth-session", "anonymous")
  @get("/stars", { query: StarsListQuery, response: StarsListResponse })
  async list(input: { query: ... }, @inject(SecurityBindings.USER) user: UserProfile) {
    const accountId = realAccount(user);
    const counts = await starCounts(this.db, input.query.kind, ids(input.query.ids));
    const mine = accountId ? await starredIds(this.db, accountId, input.query.kind, ids(...)) : [];
    return { counts, mine };
  }

  @authenticate("better-auth-session")
  @post("/stars/toggle", { body: StarsToggleBody, response: StarsToggleResponse })
  async toggle(input: { body: ... }, @inject(SecurityBindings.USER) user: UserProfile) {
    return toggleStar(this.db, realAccount(user)!, input.body.kind, input.body.id);
  }
}
```

- Kind/target validation (`KINDS`, id length ≤ 512, ids-list ≤ 100) moves into the
  Zod schemas where it maps cleanly, else stays as guards returning the same 400s.
- `installStars` and its four `get/post/options` registrations are deleted;
  `app.restController(StarsController)` replaces the `installStars(...)` call.

## Migration order (PR-by-PR, each independently shippable)

1. **PR1 (pilot):** the strategy + auth-component wiring + `publicCorsMiddleware`
   + `StarsController`. Deletes `stars/install.ts`.
2. **PR2:** `reviews`, `catalog/install`, `catalog/shares`.
3. **PR3:** `groups`, `usage`.
4. **PR4:** `handles`, `account/install`, `orgs`, `registry/uploadPublish`.
5. **PR5 (cleanup):** remove the last raw-express scaffolding + the old
   `cors`/`preflight` exports; confirm the public routes now emit in `/openapi.json`.

Each middle PR converts its modules to controllers, moves their session/account
wrapper to the shared strategy, and deletes its `install*()`.

## Error handling & edge cases

- **401/403/404/409/410 semantics preserved.** Only the mechanical 401 (`if
  (!accountId)`) moves to the framework auth phase; every other status
  (owner-gate 404 no-leak, admin 403, invite 410, rate-limit 429) stays in the
  handler and is unchanged.
- **The 401 *body*.** Today an unauthed write returns `{ error: "sign in
  required" }`. The framework's auth phase throws its own 401 with a possibly
  different body. PR1 must determine the framework's default 401 shape and, if it
  differs, either (a) customize the 401 renderer (the `RestServer.sendError`
  subclass seam) to emit `{ error: "sign in required" }`, or (b) confirm no client
  depends on that exact body and accept the change. The marketplace client's
  handling of 401 is checked in PR1; the decision is recorded there and applied
  uniformly. This is the one place the "no observable change" rule may bend, and it
  is settled in the pilot before any fan-out.
- **Reviews' in-memory rate limiter** stays app logic in the controller.
- **orgs' `res.type("text/markdown")` body** (`orgSkillBodyHandler`) returns a
  non-JSON string; the controller uses `status:`/raw-response handling to keep the
  markdown content-type. Verified against the framework's response path before PR4.
- **`registry/upload-publish`'s 25mb bodies** already work through the framework
  body-parser limit set in `createApp`; no change.
- **CORS on error responses:** the middleware runs before dispatch and sets CORS
  headers regardless of the handler's status, matching today (where `cors()` ran
  first in every handler).

## Verification

- **Per module:** the existing `__tests__` for each module must pass unchanged
  (they call the handlers/controllers and assert status + body + CORS).
- **Pilot cross-origin smoke:** a real request sequence against a booted app —
  OPTIONS preflight (asserts `Allow-Origin` reflects an allow-listed origin +
  `Allow-Credentials: true`), a credentialed GET (public counts + empty `mine`
  without a cookie), and an authed POST that 401s without a session — proving the
  strategy + middleware wire correctly end-to-end.
- **Mount-order test:** asserts `publicCorsMiddleware` answers OPTIONS for a public
  prefix (not blocked/500'd by dispatch).
- **`tsc -b` clean; `test (24)` green** before each merge.

## What dies at the end

All 10 `install*()` functions, every per-route `expressApp.get/post/options`
registration, the per-module session/account wrappers (replaced by the strategy),
and the `publicCors` **helper** (collapsed into one middleware). The raw-express
pattern is gone; `auth/mount.ts` and `account/connect.ts` remain raw by design.
