# Ingredient cards Phase 2: SKILL.md preview + reviews subsystem

Status: approved design (2026-07-04)
Branch: `feat/ingredient-cards` (continues Phase 1, PR #121)

## Context

Phase 1 (PR #121) added author, per-card star, and search to the marketplace
"Popular skills" (Ingredients) board. The star was keyed on
`(kind:"ingredient", id:"skill:<name>")` — the same key the adoption leaderboard
and ingredient detail page use — so a curated catalog card and its observed
usage-graph counterpart share one tally. That is the first edge of the intended
"proven usage graph" (Gem ↔ usage ↔ ingredient ↔ source ↔ curator ↔ user ↔
review/star/install).

Phase 2 adds the two deferred elements: **preview** (inspect a skill before
adopting) and **reviews** (`user → review → ingredient`). Reviews are the only
new subsystem; preview is frontend-only.

## Goals

- Let a user preview a skill's `SKILL.md` from its card without leaving the board.
- Let signed-in users rate + review a skill; show an aggregate on the card and the
  full list on the ingredient detail page.
- Key reviews on the same id as stars so they join the usage graph identically.
- Reuse existing seams: the `/api/sources/import` endpoint, the `stars` subsystem's
  shape, the `Ingredient` detail page, and the `Sources.tsx` content-render pattern.

## Non-goals (YAGNI — explicitly deferred)

- Moderation queue, flagging/abuse reporting.
- Replies/threading, helpful-votes.
- Pagination (review list is capped to the latest 50).
- Configurable rating scale (fixed 1–5).
- Reviews UI for gems (the backend allows it via the shared `KINDS` set, but no gem
  UI ships in this phase).

---

## A. Preview (frontend-only, no backend change)

The card holds `g.sourceId` and `s.path`; these are exactly the two arguments
`GET /api/sources/import?source=&path=` takes (verified: `curated_skills.sourceId`
is the `CURATED_SOURCES.id`, and the import handler resolves `(source, path)`
directly; the path is already `originGuard`-public + GET). `importSourceSkill`
already exists on the marketplace api client.

- Add a **`Preview`** button to each card (in `ex-skillcard-foot`, alongside the
  division tag and "View on GitHub").
- On click, lazily fetch `api.importSourceSkill(g.sourceId, s.path)` and open a
  **modal** showing `art.content` in `<pre className="ex-skill-body">` — the same
  render `Sources.tsx` uses (no markdown dependency; React escapes text, so no
  XSS). Show a loading state while fetching and an inline error on failure.
- New minimal `Modal` component (`src/Modal.tsx`, ~40 lines): fixed backdrop,
  centered panel, closes on ESC / backdrop click / a close button; `role="dialog"`
  + `aria-label`. Chosen over an inline expander so a long SKILL.md does not
  disrupt the `auto-fill` card grid.

## B. Reviews subsystem

Mirrors the existing `stars` subsystem end to end.

### Data model

New `reviews` table (created in `packages/aggregator/src/schema.ts`, parallel to
`stars`):

```sql
create table if not exists reviews (
  id uuid primary key,
  account_id uuid not null references accounts(id),
  target_kind text not null,
  target_id text not null,
  rating int not null,            -- 1..5
  body text,                      -- optional prose, <= 4000 chars
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, target_kind, target_id)
);
create index if not exists reviews_target_idx on reviews (target_kind, target_id);
```

One review per `(account, target)`. A repeat write updates the existing row
(edit). Reviewer byline is produced by joining `accounts` for `login` + `avatar_url`.

### Query module — `packages/aggregator/src/reviews.ts`

Generic `(kind, text-id)`, no FK to the target (same rationale as `stars.ts`).
Exported functions:

- `upsertReview(db, accountId, kind, id, rating, body): Promise<Review>` — insert or
  update the caller's row; bumps `updated_at`.
- `deleteReview(db, accountId, kind, id): Promise<void>` — remove the caller's row.
- `reviewSummary(db, kind, id): Promise<{ avg: number; count: number }>` — single
  target's average (rounded to 1 decimal) + count.
- `reviewSummaries(db, kind, ids): Promise<Record<string, {avg;count}>>` — batch
  version for the card grid (mirrors `starCounts`), grouped, ids capped by caller.
- `listReviews(db, kind, id, limit=50): Promise<ReviewView[]>` — latest N joined to
  `accounts` → `{ login, avatarUrl, rating, body, createdAt }`, newest first.
- `myReview(db, accountId, kind, id): Promise<Review | null>` — the caller's own row
  (so the write form can prefill for editing).

### HTTP routes — `src/reviews/install.ts`

Raw express, copied from `src/stars/install.ts` (own credentialed CORS,
`originGuard`-exempt, session via `resolveSession` + `SESSION_COOKIE`). Reuses the
shared `KINDS = {"gem","ingredient"}` allowlist. `id.length <= 512`.

| Method | Path | Auth | Body / query | Response |
|---|---|---|---|---|
| POST | `/api/reviews` | session → 401 | `{kind, id, rating:1-5, body?<=4000}` | `{ mine, summary }` |
| DELETE | `/api/reviews` | session → 401 | `{kind, id}` | `{ summary }` |
| GET | `/api/reviews` | public (+`mine` if cookie) | `?kind=&id=` | `{ summary, reviews, mine }` |
| GET | `/api/reviews/summary` | public | `?kind=&ids=` (≤100) | `{ summaries }` |
| OPTIONS | both | — | preflight | 204 |

Invalid kind/id/rating/over-long body → 400. Register via `installReviews(app, deps)`
next to `installStars`. Add `/api/reviews` to `originGuard`'s cross-site-exempt
prefixes (same line as `/api/stars`). The two public GETs also go in
`PUBLIC_READ_PATHS`.

### Marketplace client — `packages/marketplace/src/reviews.ts`

Parallels `stars.ts` (credentialed fetch; `NotSignedIn` on 401):
`getSummaries(kind, ids)`, `get(kind, id)`, `submit(kind, id, rating, body)`,
`remove(kind, id)`. Wired into `App.tsx` as a module singleton and passed through
`Router` `ReviewsCtx` (parallel to `StarsCtx`).

### Frontend surfaces

**Card (`PopularSkills.tsx`):**
- Read-only aggregate `★ {avg} · {count}` (from a batch `getSummaries` over all
  visible `skill:<name>` ids, fetched once like the star batch). Zero-count →
  render nothing or a muted "No reviews yet" affordance.
- The card **name becomes an `<a href="/ingredient/skill:<name>">`** — the
  card → detail graph edge. Keeps the star button and Preview button as-is.

**Detail page (`Ingredient.tsx`):**
- New **Reviews** `ex-card` section: the summary (`★ avg · N reviews`), the list
  (avatar · login · ★rating · body · relative date), and — for signed-in users — a
  write form (a 1–5 star picker + a textarea + submit). Signed-out users see a
  "Sign in to review" prompt linking to `stars.loginUrl()` (reuse existing auth).
  The caller's existing review prefills the form; author gets edit (re-submit) and
  delete.

## Error handling

- Writes are optimistic where cheap (star already is); the review form shows a
  pending state and reverts on error, surfacing `NotSignedIn` → redirect to login
  (same pattern as `StarButton`).
- All public summary reads are best-effort: a failing `getSummaries` leaves cards
  without an aggregate rather than breaking the board (mirrors `gemAdoption`).

## Testing

- **Query-module unit (`src/aggregator/__tests__/reviews.test.ts`, mirrors
  `stars.test.ts`):** uses `makeTestDb` + `upsertAccount` from `@agentgem/aggregator`.
  Covers upsert then edit (row count stays 1, rating/body/`updated_at` change),
  `reviewSummary` avg + count, `reviewSummaries` batch grouping, `listReviews` join +
  ordering + limit, `deleteReview`.
- **Route (`src/__tests__/reviewsInstall.test.ts`, mirrors `starsInstall.test.ts`):**
  401 unauth POST/DELETE, 400 invalid rating/kind/over-long body, public GET shape,
  CORS/preflight.
- **Frontend:**
  - `Ingredient.test.tsx`: reviews section renders summary + list; signed-in shows
    the form and a submit posts; signed-out shows the sign-in prompt; delete removes.
  - `PopularSkills.test.tsx`: card renders `★ avg · N` from a stubbed summary; card
    name links to `/ingredient/skill:<name>`; Preview button opens the modal with
    fetched content.
  - `Modal.test.tsx`: opens, closes on ESC/backdrop/close button.

## Build order

1. Backend: `reviews` schema + `reviews.ts` query module + tests.
2. Backend: `src/reviews/install.ts` routes + `originGuard` exemptions.
3. Marketplace client: `reviews.ts` + `App.tsx`/`Router` `ReviewsCtx` wiring.
4. Preview: `Modal.tsx` + card Preview button + test.
5. Card: aggregate rating + title→detail link.
6. Detail page: reviews section (summary + list + write form) + tests.
7. Full marketplace + aggregator suites + typecheck; live-browser verification.
