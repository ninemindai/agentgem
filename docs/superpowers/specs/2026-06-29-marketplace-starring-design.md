# Marketplace Starring (M2-B) — Design

**Date:** 2026-06-29
**Status:** Approved — ready for implementation plan

## Goal

Let signed-in users star/unstar **gems and ingredients**; everyone sees public star counts. Built on the live M2-A web session. A star button appears on all four marketplace surfaces (gem cards, gem detail, leaderboard rows, ingredient pages).

## Context

M2-A shipped GitHub web sign-in: `resolveSession(db, token) → { login, avatarUrl, accountId } | null` gates authed writes; the SPA's `makeAuth` makes credentialed calls; the raw-express + credentialed-CORS + originGuard-exemption pattern is established in `src/auth/install.ts` + `src/index.ts`.

**Hard lesson carried from M2-A:** any new cross-site path (the SPA on `app.agentgem.ai` → the API on `api.agentgem.ai`) is rejected by `originGuard`'s cross-site block unless exempted. So `/api/stars/*` must be exempted in `originGuard` AND tested *through* the guard (not just the handlers in isolation — that gap is what shipped the auth bug).

**Structural fact:** ingredients live in the aggregator DB (`ingredients.id`, e.g. `skill:superpowers/brainstorming`), but gems do **not** — they're the static catalog / registry (key like `brainstorming-kit`). So the star target is stored as plain text (no FK), generic over both kinds.

## Decisions (settled in brainstorming)

- **Starrable:** both gems and ingredients (one generic `stars` table, `kind` + `id`).
- **Counts are public:** everyone sees ★ N (stars are explicit public engagement, not k-anon telemetry).
- **Signed-out click → prompt sign-in:** the click kicks off the GitHub sign-in flow returning to the same page. The star is NOT auto-applied on return (no star-on-return in M2-B); the user clicks again once signed in.
- **One combined read endpoint:** `GET /api/stars` returns public counts for everyone, plus the caller's starred ids (`mine`) when a session cookie is present.

## Store (`@agentgem/aggregator`)

New `stars` table (drizzle `pgTable` + `ensureSchema` DDL):
- `id uuid pk`, `accountId uuid → accounts(id)`, `targetKind text` (`'gem' | 'ingredient'`), `targetId text`, `createdAt timestamptz default now()`.
- **Unique** `(account_id, target_kind, target_id)`; **index** `(target_kind, target_id)` for count queries.

Pure store fns (tested against `makeTestDb`):
- `toggleStar(db, accountId: string, kind: string, id: string): Promise<{ starred: boolean; count: number }>` — if the (account, kind, id) star exists, delete it; else insert it; then return `{ starred: <now-exists>, count: <fresh count for (kind,id)> }`.
- `starCounts(db, kind: string, ids: string[]): Promise<Record<string, number>>` — count per id (ids not present → 0 / omitted; the client treats missing as 0).
- `starredIds(db, accountId: string, kind: string, ids: string[]): Promise<string[]>` — which of `ids` this account has starred.

## Backend — `src/stars/install.ts` (raw express, the M2-A pattern)

`installStars(expressApp, deps: { db, webOrigins: string[] })` registers:
- **`POST /api/stars/toggle`** — authed: read the session cookie (reuse `SESSION_COOKIE`/`parseCookies` + `resolveSession`); **401 `{ error: "sign in required" }`** if no valid session. Body `{ kind, id }` (validate `kind ∈ {gem,ingredient}`, non-empty `id`; 400 otherwise). Calls `toggleStar`; returns `{ starred, count }`.
- **`GET /api/stars?kind=&ids=a,b,c`** — `kind` validated; `ids` = comma-split (cap at, say, 100). Returns `{ counts: Record<id,number> }` from `starCounts`, **plus** `{ mine: string[] }` (from `starredIds`) when a valid session cookie resolves to an account; `mine: []` otherwise. Never 401 (public read).
- **`OPTIONS`** on both (credentialed preflight), mirroring the auth routes.
- Both use a shared `corsForStars(req, res, webOrigins)` that echoes an allowlisted `Origin` + `Allow-Credentials: true` (never `*`), `Vary: Origin` — identical to `authCors`.

**originGuard:** add `req.path.startsWith("/api/stars/")` to the same cross-site exemption branch that `/api/auth/` uses (or a combined check). NOTE the GET path is `/api/stars` (no trailing segment) — the exemption must match both `/api/stars` and `/api/stars/toggle`; use `req.path === "/api/stars" || req.path.startsWith("/api/stars/")` (or `startsWith("/api/stars")`).

**`index.ts`:** mount `installStars(server.expressApp, { db: aggDb, webOrigins })` right after `installAuth`, gated on `aggDb && webOrigins.length > 0` (stars need the DB + an allowlisted origin; they don't need the GitHub OAuth secret).

## Frontend (`packages/marketplace`)

- **`makeStars(base)`** (`src/stars.ts`): `get(kind, ids: string[]): Promise<{ counts: Record<string,number>; mine: string[] }>` (GET, `credentials:'include'`); `toggle(kind, id): Promise<{ starred: boolean; count: number }>` (POST, `credentials:'include'`; on 401 throws a typed `NotSignedIn`).
- **`<StarButton>`** (`src/StarButton.tsx`) — props `{ kind, id, count, starred, signedIn, loginUrl: () => string, api }`. Renders `☆/★ count`. Click: if `!signedIn` → `window.location.href = loginUrl()`; else optimistic flip (update local count/starred immediately), call `api.toggle`, reconcile with the returned `{ starred, count }` (revert on error). `aria-pressed`, `aria-label`.
- **Star context:** `App` already loads `me` (signed-in) + has `auth`. Thread a `stars` object `{ signedIn: !!me, loginUrl: () => auth.loginUrl(window.location.href), api: makeStars(defaultApiBase()) }` from `App` → `Router` → the pages (new optional `stars` prop on `Router`/pages).
- **Wire the 4 surfaces:** each page, after its existing data loads, batch-calls `stars.api.get(kind, ids)` once for its visible ids, then renders a `StarButton` per item with `count = counts[id] ?? 0`, `starred = mine.includes(id)`:
  - **Leaderboard** (`kind:"ingredient"`, ids = the popularity ids) — a star on each row.
  - **Ingredient** detail (`kind:"ingredient"`, the single id) — a star by the header.
  - **Gems** browse (`kind:"gem"`, the gem keys) — a star on each card.
  - **Gem** detail (`kind:"gem"`, the key) — a star by the title.

## Data flow

Page load → `GET /api/stars?kind&ids` (counts for all + `mine` if signed in) → render StarButtons. Signed-in click → optimistic flip → `POST /api/stars/toggle` → reconcile count (revert on failure). Signed-out click → redirect to `loginUrl()` (GitHub sign-in, returns to the page).

## Out of scope (later)

- Star-on-return (auto-apply the intended star after sign-in).
- Sorting / "most starred" views, a starred-items page, notifications (M2-C territory).
- Starring anything beyond gems + ingredients.

## Testing

- **Store** (`makeTestDb`): toggle inserts then deletes (idempotent round-trip); `count` reflects multiple accounts; `starCounts` batch; `starredIds` returns only the account's stars.
- **stars endpoints** (mock req/res + `makeTestDb`, like `authInstall.test.ts`): POST toggle 401 without a session, toggles + returns `{starred,count}` with one; GET returns public counts always and `mine` only with a cookie; bad `kind`/`id` → 400; credentialed CORS for an allowlisted origin only; OPTIONS preflight.
- **originGuard:** cross-site `POST /api/stars/toggle` and `GET /api/stars` both pass the guard (nexted), while a cross-site non-star/non-auth path still blocks — driven *through* `originGuard` (the M2-A coverage gap).
- **Frontend** (vitest+jsdom): `makeStars` URL/credentials/401-typing; `StarButton` renders count, optimistic toggle calls `api.toggle` and reconciles, signed-out click navigates to `loginUrl`; each page batch-fetches and renders a StarButton with the right kind/id.
- Gates: server `pnpm test` (compiled dist) incl. the new store/endpoint/originGuard tests; `pnpm --filter @agentgem/marketplace test|typecheck|build`.

## Risks

- **originGuard path match** — `/api/stars` (GET, no trailing slash) must be exempted alongside `/api/stars/toggle`; a `startsWith("/api/auth/")`-style check with a trailing slash would miss the bare GET path. Use `startsWith("/api/stars")`.
- **Cross-site cookie** for `POST`/the `mine` read — same parent-domain-cookie constraint as M2-A (only round-trips on the real `*.agentgem.ai`); counts still render everywhere (the public part needs no cookie).
- **Optimistic UI drift** — always reconcile against the server's returned `count` and revert on error so counts can't desync.
