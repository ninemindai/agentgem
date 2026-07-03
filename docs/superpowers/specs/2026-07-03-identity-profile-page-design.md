# Unified GitHub Identity — Sub-project 2: Public profile page (`/@login`)

Date: 2026-07-03
Status: Design — pending user review
Branch: `feat/identity-profile-page` (off `origin/main` @ 40f1ede)

## Context

This is **sub-project 2 of 3** in the unified-identity effort. SP1 (reconcile
bindings ↔ accounts + capture avatar, PR #87) made the console device-flow bind
write the canonical `accounts` row (with avatar) via `upsertAccount`. SP2 gives
that identity a public home: a profile page at `app.agentgem.ai/@<login>`
showing the user's avatar, their published gems, and each gem's engagement.

**Decomposition recap (each its own spec → plan):**
1. SP1 — reconcile `account_bindings` ↔ `accounts` + avatar in console Settings (PR #87, shipped).
2. **This doc** — public profile page `/@login`.
3. SP3 — avatars/author links everywhere (explore/marketplace + console listings).

### Terminology correction (pinned during brainstorming)

AgentGem has **no 1–5 rating scale and no written reviews** — only binary
**stars** (`stars` table, one per account per gem, aggregated to a count via
`starCounts`). "Ratings" on the profile therefore means **star counts**, reusing
the existing stars system. Building a rating/review system is an explicit
**non-goal** (out of scope for SP2).

### Relevant existing code (verified on this branch)

- **Marketplace** (`packages/marketplace`): a static Vite/React SPA. Client-side
  routing is a tiny `popstate` matcher in `src/Router.tsx` (no React Router).
  Pages use plain `<a href>`; `App` intercepts same-origin clicks →
  `pushState` + `popstate`. Reads the API cross-origin via `VITE_API_BASE`
  (`api.agentgem.ai`). Deployed as a Render static site.
- **`accounts`** (`packages/aggregator/src/schema.ts:78-85`):
  `id, provider, provider_account_id, login, avatar_url, created_at`; unique
  `(provider, provider_account_id)`. `avatar_url` is nullable.
- **`account_bindings`** (`schema.ts:53-59`):
  `pubkey → provider, account_id, account_login, bound_at`. The verified-identity
  link (device-flow bound).
- **`catalog_gems`** (`schema.ts:119-130`):
  `gem_key, version, published_by (GitHub login), author?, description?, tags,
  artifact_kinds, type, grade, created_at_ms`; PK `(gem_key, version)`.
  `published_by` is the **only** author linkage — a plain login string, no FK.
- **`stars`** (`schema.ts:95-101`): `id, account_id → accounts.id, target_kind,
  target_id, created_at`; unique `(account_id, target_kind, target_id)`.
  Aggregation in `packages/aggregator/src/stars.ts`: `starCounts(db, kind, ids)`
  → `Record<id, number>` (bulk).
- **`gem_adoptions`** (`schema.ts:103`, `:153`): `gem_key, gem_digest,
  producer_pubkey, account_login?, event, adopted_at, …`; PK
  `(gem_key, producer_pubkey)`. Install count per gem =
  `count(distinct producer_pubkey)` (idiom already used in
  `packages/aggregator/src/projectAdoption.ts:39`).
- **Route idiom** (`src/aggregator.controller.ts`): `@api({ basePath:
  "/api/aggregator" })` class; `@get("/popularity", { query, response })`
  methods with Zod schemas; registered via `app.restController(...)` in
  `src/index.ts`. Public reads are CORS-listed in the origin guard.
- **`webAuth.ts`**: `upsertAccount(db, {provider, accountId, login, avatarUrl?})`,
  `resolveSession(db, token)`. There is **no** profile endpoint today.

## Design decision

**One aggregated public endpoint + a client-rendered SPA page.** Add
`GET /api/aggregator/profile/:login` that assembles the whole profile in one
query set; the marketplace adds a `/@login` route and a `Profile.tsx` page that
renders it. This matches the marketplace's existing architecture (static SPA ↔
cross-origin JSON API), keeps all joins server-side, and needs one round-trip.

**Rejected alternatives:**
- *Client composes from existing endpoints* (no new backend): there is no exposed
  "gems by author" read, so the client would fetch the whole catalog and filter —
  wrong layer, multiple round-trips, and avatar/verified still need an endpoint.
- *Server-rendered `/@login` HTML for SEO + OG unfurl cards*: real value for
  shareability, but the marketplace is a static SPA; SSR is a larger lift than
  the profile itself. **Deferred** as a follow-up slice (see Non-goals).

**Decoupling from PR #87 (deliberate):** gems link to authors by the plain
`catalog_gems.published_by` **login string**, not a FK to `accounts.id`. So the
gem list renders even for a bind-only user who has no `accounts` row; `accounts`
merely *enriches* the profile with an avatar. SP2 therefore does **not**
hard-depend on PR #87 — #87 only makes avatars appear for more users. The
profile endpoint degrades gracefully (avatar `null`) when no `accounts` row
exists.

## Part A — backend: endpoint + builder

### Endpoint

`GET /api/aggregator/profile/:login` on `AggregatorController`
(`basePath: /api/aggregator`), public read (added to the origin guard's
public-read paths). Response (Zod) shape:

```jsonc
{
  "login": "rfeng",                       // canonical from accounts if present, else the requested param
  "avatarUrl": "https://…" | null,
  "verified": true,                        // an account_bindings row exists for this login
  "githubUrl": "https://github.com/rfeng",
  "totalStars": 128,
  "gems": [
    {
      "key": "brainstorming-kit",
      "version": "1.2.0",                  // latest version for this key
      "description": "…" | null,
      "grade": 3,                           // catalog_gems.grade | null
      "stars": 92,
      "installs": 40
    }
  ]
}
```

`404` (AgentError not-found) when the login has **no `accounts` row AND no
catalog gems AND no binding**.

### Builder — `packages/aggregator/src/profile.ts`

`export async function buildProfile(db: AppDb, login: string): Promise<Profile | null>`

Steps:
1. **Validate charset**: reject if `login` does not match `^[A-Za-z0-9-]+$`
   (GitHub login charset). Invalid → return `null` (endpoint 404s) — bad input
   never reaches a query or the GitHub URL builder. (Note: the `:login` route
   param arrives already stripped of any leading `@`; the pretty `/@login` is a
   frontend URL only.)
2. **Account** (case-insensitive): `select login, avatar_url from accounts where
   lower(login) = lower(:login) limit 1`. Supplies `avatarUrl` and the canonical
   `login` casing. May be absent.
3. **Verified**: `select 1 from account_bindings where lower(account_login) =
   lower(:login) limit 1` → boolean.
4. **Gems** (case-insensitive, latest version per key): from `catalog_gems`
   where `lower(published_by) = lower(:login)`, one row per `gem_key` — the one
   with the greatest `created_at_ms` — returning `gem_key, version, description,
   grade`. (Postgres `distinct on (gem_key) … order by gem_key, created_at_ms
   desc`; the same result is achievable portably for pglite via a grouped
   subquery on `max(created_at_ms)`. Implementation picks the form that runs on
   both — plan will specify the exact SQL and assert it in tests.)
5. **Stars**: `starCounts(db, "gem", gemKeys)` (existing bulk helper) →
   per-gem `stars`; `totalStars` = sum.
6. **Installs**: **add** a bulk helper (in `profile.ts` or beside
   `projectAdoption.ts`): `select gem_key, count(distinct producer_pubkey)::int
   as c from gem_adoptions where gem_key = any(:keys) group by gem_key` →
   per-gem `installs` (missing key → 0).
7. **Empty check**: if `!account && gems.length === 0 && !verified` → `null`.
8. Assemble: `login` = account's canonical login if present else the requested
   value; `githubUrl` = `https://github.com/${login}`; gems sorted by `stars`
   desc then `key` asc for stable ordering.

## Part B — frontend: marketplace page + entry point

### Route + page

- **`Router.tsx`**: add, before the leaderboard fallback,
  `const prof = path.match(/^\/@([^/]+)$/); if (prof) return <Profile api={api}
  login={decodeURIComponent(prof[1])} stars={stars} />;`
- **`pages/Profile.tsx`** (new): on mount, fetch via a new `api.profile(login)`
  method. States:
  - *loading* → a lightweight placeholder.
  - *not found* (404) → a "No profile for @login" message.
  - *loaded* → header: avatar `<img>` (round; omitted when `avatarUrl` null —
    text-only fallback, no broken image), `@login`, a `✓ Verified` badge when
    `verified`, a GitHub link (`githubUrl`), and `★ {totalStars}`. Below: a gem
    grid **reusing the existing gem-card markup/classes** from `pages/Gems.tsx`
    (do not restyle), each card linking to `/gems/:key` and showing the gem's
    grade badge, `★ stars`, and `installs`.
- **`api.ts`**: add `profile(login: string)` returning the typed response
  (types kept byte-identical to the server Zod schema — the repo's recurring
  client/server-contract gotcha).

### Discovery entry point

On the gem detail page (`pages/Gem.tsx`), render the author / `published_by`
value as `<a href={`/@${login}`}>@{login}</a>`. This is how users reach
profiles; App's click-interceptor makes the link navigate with no extra wiring.
(Broader "author links everywhere" in listings is SP3.)

## Error handling / edges

- **Case-insensitivity** for account, binding, and gem lookups (GitHub logins are
  case-insensitive; `/@RFeng` must resolve `rfeng`). Canonical casing for
  display comes from the `accounts` row when present.
- **Charset validation** (step 1) rejects anything outside `^[A-Za-z0-9-]+$`
  before any query or URL construction.
- **All SQL parameterized** (drizzle `sql``` / query builder) — no interpolation
  of `login` into SQL text.
- **Bind-only user (no `accounts` row, e.g. pre-#87)**: avatar `null`, page still
  renders from catalog gems.
- **Gem with no stars/installs** → `0`, not missing.
- **Unknown login** → endpoint 404 → Profile "not found" UI.

## Testing

**Backend (`buildProfile`, pglite):**
- Account with gems + stars + installs → full shape, correct per-gem counts,
  `totalStars` = sum, gems sorted stars-desc.
- Bind-only login (gems + binding, no `accounts` row) → `avatarUrl: null`,
  `verified: true`, still returns a profile.
- Two versions of one `gem_key` → only the latest version appears (dedupe).
- `verified` false when no binding; true when a binding exists.
- Unknown login (no account, no gems, no binding) → `null`.
- Case-insensitive: `buildProfile(db, "RFeng")` finds `rfeng`'s data.
- Bad charset (`"foo/bar"`, `"a b"`, empty) → `null` (no query executed).

**Endpoint:** `GET /profile/:login` → 200 with the schema for a known login;
404 for an unknown one.

**Frontend (`Profile.tsx`, Router):**
- Renders the gem grid from a mocked response; each card links to `/gems/:key`.
- `✓ Verified` badge shown only when `verified: true`.
- Avatar `<img>` present with `avatarUrl`; text-only header when `null`.
- Not-found response → not-found UI.
- `Router` matches `/@login` → `Profile`.

## Non-goals (later sub-projects / out of scope)

- A 1–5 rating scale or written reviews (SP2 reuses binary stars only).
- Server-rendered `/@login` HTML for SEO / OG unfurl cards (future slice).
- Bio / custom profile fields / editable profiles.
- SP3's avatars + author links across explore/marketplace/console listings
  (beyond the single gem-detail author link above).
- Changing the web OAuth sign-in or the SP1 reconciliation.

## Self-review

- **Placeholders:** none — every change names a real file/table/function
  verified on this branch (`Router.tsx`, `pages/Gems.tsx`, `pages/Gem.tsx`,
  `api.ts`, `AggregatorController`, `schema.ts` tables, `starCounts`,
  `gem_adoptions` idiom).
- **Consistency:** author linkage keyed on `login` throughout (route param,
  `catalog_gems.published_by`, `account_bindings.account_login`, `accounts.login`),
  all matched case-insensitively; response types shared verbatim client/server.
- **Scope:** one endpoint + one builder + one page + one route match + one
  author link + tests. Rating system and SSR are explicit non-goals.
- **Ambiguity:** "ratings" pinned to existing star counts; "profile URL" is the
  pretty `/@login` on the frontend while the API is `/api/aggregator/profile/:login`;
  the empty/404 condition is stated precisely.
- **Dependency:** SP2 functions on `origin/main` without PR #87 (avatar just
  absent for bind-only users); #87 is an enhancer, not a prerequisite.
