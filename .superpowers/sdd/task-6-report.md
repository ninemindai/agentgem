# Task 6 report: POST /api/handle

## What changed

- **Created** `src/handles/install.ts` — `installHandles(expressApp, deps)` registers
  `POST /api/handle` (plus its `OPTIONS` preflight) as a thin adapter over Task 5's `claimHandle`.
  Status mapping is exactly the brief's table: no session → 401; body has no `handle` string →
  400; `reason: "charset"` → 400; `reason: "unavailable"` → 409; success → 200 `{ handle }`.
  `"taken"` and `"reserved"` both arrive as `claimHandle`'s single `reason: "unavailable"` and are
  never distinguished in the response (same status, same error message, no distinct code).
- **Created** `src/handles/__tests__/install.test.ts` — 4 tests, all calling the exported
  `claimHandler(deps)` (the same function `installHandles` wires onto express), never
  `claimHandle` directly.
- **Modified** `src/index.ts` — imported `installHandles` and registered it beside
  `installGroups`/`installUsage` inside the existing `if (aggDb && webOrigins.length > 0 && auth)`
  block, passing the same `{ db: aggDb, auth, webOrigins }` deps shape as its neighbors.

## Route template used, and why

Used **`src/catalog/install.ts`** for the module shape per the brief's instruction: inline
`Req`/`Res` interfaces (no `@types/express` dependency), a local `cors()` function keyed off an
origin allowlist, a local `preflight()` helper for `OPTIONS`, and an `ExpressApp` type that only
exposes the HTTP methods this route actually uses (`post` + `options`, mirroring catalog's
`delete` + `options`). There is no `../http/cors.js` module anywhere in this repo — the brief's
step-3 code block imports `cors` from there, but every real `install.ts` (catalog/groups/stars/
usage) defines `cors` inline, so I followed the actual pattern instead of the brief's literal
import path. One adjustment from catalog: catalog's `Req` has no `body` field (its route is
DELETE-by-query-string only); I added `body: Record<string, unknown>`, matching
`groups/install.ts`'s `Req` shape, since this route reads `req.body.handle`.

## Test harness used, and why

`src/catalog/__tests__/install.test.ts` does not exist (confirmed by `find`). Per the brief's own
"context the brief cannot know" section, I used **`src/groups/__tests__/install.test.ts`** as the
harness template — it's the one real route test in this repo that both (a) lives at
`src/<area>/__tests__/`, and (b) mints a session via `mintBetterAuthCookieForTest` (imported from
`@agentgem/aggregator/testing`). Like every install-route test in this codebase (groups, stars,
usage), it calls the exported handler directly with hand-rolled `req()`/`res()` mocks rather than
supertest+a real express() app — that is the established convention here, not the brief's
step-1 sketch (`request(app)` / `makeHandleApp()` / a separate `helpers.ts`), which doesn't match
any test file that actually exists in the repo. I kept the harness in one file, matching
groups/stars/usage (no shared `helpers.ts` exists for any of those either).

Test cases (4, matching the brief's expected count):
1. `401 without a session`
2. `200 and persists on a free handle` — asserts the response body AND queries `"user".handle`
   directly to confirm the write landed.
3. `400 on charset, 409 on taken, 409 on a reserved org name` — covers both 409 causes and asserts
   `reserved.code === taken.code` and `reserved.body` deep-equals `taken.body`, i.e. genuinely
   indistinguishable, not just "both happen to be 409".
4. `400 when the body carries no handle string`

## A brief SQL bug I did not carry forward

The brief's Step 1 test snippet reserves a name with
`insert into org_members (scope, gh_login, role) values (...)`. The actual `org_members` table
(`schema.ts:201`) has no `scope` column — it's `org_scope` (confirmed by reading `schema.ts` and by
`handles.ts`'s own `isReserved` query; independently called out in the task's "context the brief
cannot know" section: "org_members.org_scope and org_settings.scope — note the column names, they
differ"). I used `org_scope` in the test; the brief's literal SQL there would have failed at the
database with an unknown-column error rather than produce a false pass, so this wasn't a silent
divergence — I verified it against the live schema before writing it.

## The `accounts` anchor gotcha (not spelled out in the brief)

`mintBetterAuthCookieForTest` signs up through its own **throwaway** better-auth instance (see
`packages/aggregator/src/auth/testCookie.ts`) that shares `db`/`secret`/`baseURL` with the instance
under test but does **not** carry `makeAuth`'s `databaseHooks.account.create` hook (hooks are
per-instance, defined in `betterAuth.ts`). That hook is what writes the legacy `accounts` anchor
row on a real GitHub sign-in. So a cookie minted this way produces a `"user"` row with no matching
`accounts` row. `claimHandle` succeeds at the `"user".handle` update but then calls
`setAccountScopes`, which inserts into `account_scopes` — FK'd to `accounts.id` — and 500s with a
foreign-key violation on PGlite (`23503`).

This is exactly the shape of the gotcha the brief's own context section warned about generically
("If your fixture inserts rows directly, it must insert into both accounts and "user" with the
same id"), just arrived at via `mintBetterAuthCookieForTest` instead of a raw insert. Fix: my
`signedIn()` test helper inserts a matching `accounts` row (`id`, `provider: 'test'`,
`provider_account_id`) with the same uuid right after resolving the session, before exercising the
route. Caught by watching the first "200" test fail with a real PGlite FK error before patching the
helper — not caught by inspection ahead of time.

## Commands run (verbatim) and results

```
$ pnpm clean && pnpm exec tsc -b
$ pnpm exec vitest run dist/handles/__tests__/install.test.js
 Test Files  1 passed (1)
      Tests  4 passed (4)
```

Confirmed test count matches (4, as the brief expected). Re-ran the exact clean/build/verify
sequence a second time to rule out a stale-artifact false green — same result both times.

Broader regression pass (root + aggregator route/DB tests):
```
$ pnpm exec vitest run dist/__tests__ dist/aggregator/__tests__ dist/groups dist/stars dist/catalog dist/usage dist/handles --reporter=dot
 Test Files  1 failed | 127 passed (128)
      Tests  1 failed | 844 passed (845)
```
The single failure is `dist/__tests__/consoleMount.test.js` ("serves the React console at / and
/console"), which fails because the console bundle isn't built in this worktree
(`console not built — run pnpm build`) — this is the exact pre-existing harness quirk the brief's
global constraints call out as not-a-regression. No other test file was affected by this change.

## Anything the brief left open

- **`originGuard.ts` is not updated.** `/api/handle` is a new top-level path and is not in
  `originGuard.ts`'s cross-site exemption list (`/api/stars`, `/api/reviews`, `/api/usage`,
  `/api/catalog/`, etc. — see `src/originGuard.ts`). Every sibling route that needs to be callable
  cross-site (console on one origin, API on another, per the two-app split) has an explicit prefix
  entry there. The brief's file list for Task 6 was exactly `src/handles/install.ts`,
  `src/index.ts`, and the test file, and did not mention `originGuard.ts`, so I left it untouched
  rather than expanding scope unilaterally. **This is a real gap**: as shipped, a genuine
  cross-site browser POST to `/api/handle` (`Sec-Fetch-Site: cross-site`) would be blocked by
  `originGuard` before ever reaching this route's own CORS/session logic, in production. If the
  handle-claim UI is meant to be called from the console's origin against a separately-hosted API
  (the same shape stars/catalog/groups solve for), `/api/handle` likely needs an entry in
  `originGuard.ts`'s exemption list in a follow-up task. Flagging rather than fixing, since it's
  outside this task's stated file list.
- Not otherwise ambiguous: the status-code table, the 409-collapsing requirement, and the
  `who.accountId`-not-`who.login` guidance were all followed to the letter and were sufficient to
  implement without further judgment calls.

## Concerns

- The `originGuard.ts` gap above is the one open item I'd want a human decision on before this
  route is relied on in production from a cross-origin console.
- No other concerns — `claimHandle` is called exactly once, with no re-validation, no second claim
  path, and the 409 responses for "taken" vs "reserved" are verified (not just assumed)
  indistinguishable by the test.

## Note on an unrelated pre-existing change

`.superpowers/sdd/task-5-report.md` showed as modified in `git status` before this task started
(not something I touched) — left as-is, not staged in this task's commit.

## Fix pass (originGuard exemption)

**The bug:** `POST /api/handle` (Task 6) is a credentialed cross-origin write (marketplace SPA on
`app.agentgem.ai` → API on `api.agentgem.ai`), but `src/originGuard.ts`'s prefix exemption at line
68 never listed it — flagged as an open gap in this same report above. A real cross-origin browser
POST was rejected by the guard with a 403 before ever reaching the route's own CORS/session logic
(only same-origin console calls and header-less `curl` worked, masking the bug).

**Prefix form chosen:** `req.path.startsWith("/api/handle")` — no trailing slash. `/api/handle` is
a single leaf endpoint (only `POST`/`OPTIONS` on that exact path, no sub-routes — see
`installHandles` in `src/handles/install.ts`), the same shape as `/api/registry/upload-publish`
(also a specific single action route), not a namespace like `/api/orgs/` or `/api/catalog/` that
covers multiple sub-paths and therefore needs the trailing slash to avoid matching a bare parent
path with no trailing content. A trailing-slash form (`/api/handle/`) would not even match the
real request path `/api/handle` (no trailing slash), so it was never in contention functionally —
the real choice was between the bare `upload-publish`-style prefix (accepted, matching precedent)
and a stricter `path === "/api/handle"` exact check (rejected: none of the eight existing
exemptions use exact-match, and introducing one net-new pattern for a single route was more
diff than the bug needed). Went with the bare form to match `/api/registry/upload-publish`'s
precedent exactly.

Updated the comment block above the exemption line (originGuard.ts:53-67) with one clause
covering `/api/handle`'s rationale, in the same voice/density as the existing route callouts.

**Test added** (`src/__tests__/originGuard.test.ts`): "allows the cross-site handle-claim POST
(/api/handle) — credentialed, own CORS + 401 gate", mirroring the existing
`/api/registry/upload-publish` and `/api/catalog/*` cases (cross-site `Sec-Fetch-Site`, asserts
`nexted === true`, `blocked === false`).

**Discriminating-test experiment:** temporarily removed `|| req.path.startsWith("/api/handle")`
from the exemption line, rebuilt, and reran:

```
$ pnpm clean && pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/originGuard.test.js
 FAIL  dist/__tests__/originGuard.test.js > originGuard (CSRF / drive-by guard) > allows the cross-site handle-claim POST (/api/handle) — credentialed, own CORS + 401 gate
AssertionError: expected false to be true // Object.is equality
 Test Files  1 failed (1)
      Tests  1 failed | 41 passed (42)
```

Restored the fix, rebuilt, reran — back to green:

```
$ pnpm clean && pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/originGuard.test.js dist/handles/__tests__/install.test.js
 Test Files  2 passed (2)
      Tests  47 passed (47)
```

**Disallowed origin still rejected:** originGuard's prefix exemption calls `next()` unconditionally
for the exempted credentialed routes (same as every other route in that list — origin enforcement
for these routes lives in the route's own CORS, not in originGuard). So the real proof of "unknown
Origin rejected" is at the route level, not originGuard: added "OPTIONS from a foreign origin sets
no ACAO header" to `src/handles/__tests__/install.test.ts`, mirroring the identical pre-existing
pattern in `src/groups/__tests__/install.test.ts:73-79` — asserts `claimHandler`'s own `cors()`
does not set `Access-Control-Allow-Origin` for `https://evil.example`, which is what actually stops
a disallowed origin's browser from reading the response (and, separately, `claimHandler` still
gates on a valid session — 401 without one, regardless of Origin). Verified passing in the 47/47
run above. `originGuard.ts`'s own cross-site-but-unlisted-path tests (e.g. "still blocks a
cross-site request to a NON-auth API path") were left untouched — no other route's exemption was
changed, and `PUBLIC_READ_PATHS` was not touched.
