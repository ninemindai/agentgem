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

## What already exists (reuse, don't reinvent)

No `DESIGN.md`; the design system is the `ex-*` classes in
`packages/marketplace/src/styles.css` plus a few components. Reuse:

- **`stars` subsystem** (`packages/aggregator/src/stars.ts`, `src/stars/install.ts`,
  marketplace `stars.ts` + `StarButton.tsx`) — the entire shape reviews copy: generic
  `(kind, text-id)`, session cookie auth, `originGuard` exemption, credentialed CORS,
  `KINDS` allowlist, batch-count read.
- **`Ingredient.tsx`** detail page — the host for the reviews section; already receives
  `StarsCtx` and fetches star state, so `ReviewsCtx` slots in the same way.
- **`Sources.tsx`** — the `importSourceSkill` + `<pre className="ex-skill-body">` render
  is the Preview precedent (no markdown dep, React escapes text).
- **Components/classes:** `StarButton`, `ex-card`, `ex-avatar*` (Profile), `ex-star`,
  `ex-empty`, `ex-error`, `ex-search` (input styling), existing button class.
- **`prettifyId`** — turns `skill:<name>` into a display name on the detail page.

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
  visible `skill:<name>` ids, fetched once like the star batch). **Zero-count renders
  nothing** — not a "No reviews yet" label on every card. With 72 cards mostly at
  zero early on, a per-card empty label is grid noise (subtraction default); the
  aggregate appears only once a skill has reviews.
- The card **name becomes an `<a href="/ingredient/skill:<name>">`** — the
  card → detail graph edge. Keeps the star button and Preview button as-is.

**Detail page (`Ingredient.tsx`):**
- New **Reviews** `ex-card` section placed **first, directly under the header + star**
  — page order becomes header+★ → **Reviews** → "Used together with" → "Adoption".
  Reviews lead because a visitor wants human social proof and to contribute before the
  machine stats (hierarchy as service). The section holds the summary
  (`★ avg · N reviews`), the list (avatar · login · ★rating · body · relative date),
  and — for signed-in users — a write form (a 1–5 star picker + a textarea + submit).
  Signed-out users see a "Sign in to review" prompt linking to `stars.loginUrl()`
  (reuse existing auth). The caller's existing review prefills the form; author gets
  edit (re-submit) and delete.

See **Design detail** below for the per-state behaviour, the ★-not-◆ ruling, and the
accessibility spec this section depends on.

## Design detail (from the 2026-07-04 design review)

### Information architecture

- **Detail page order:** header+★ → **Reviews** → "Used together with" → "Adoption"
  (decided in review; reviews lead for social proof + contribution).
- **Card scan order:** name (now a link) → ★review-aggregate (only if count>0) →
  description → author byline → division tag · Preview · GitHub. The star (personal)
  and the review-aggregate (crowd) are distinct signals; keep the personal ★star pill
  top-right and the crowd `★ avg · N` inline in the footer so they don't read as one.

### Interaction states

Every new surface specifies what the user SEES per state:

```
SURFACE          | LOADING                     | EMPTY                                   | ERROR                                  | POPULATED / SUCCESS
-----------------|-----------------------------|-----------------------------------------|----------------------------------------|-------------------------------------
Card aggregate   | nothing (card already useful)| render nothing (count 0)               | silent — best-effort, like gemAdoption | "★ 4.6 · 12"
Preview modal    | "Loading SKILL.md…" in panel| "This skill has no SKILL.md body."      | "Couldn't load preview: <msg>" + Retry | <pre class="ex-skill-body"> content
Reviews list     | "Loading reviews…"          | warm: "No reviews yet — be the first to review <name>." + form focused | "Couldn't load reviews: <msg>"        | <ul> of reviews, newest first
Write form       | submit disabled + "Posting…"| n/a (form always present when signed in)| inline ex-error, input preserved       | optimistic upsert; form flips to "Your review" edit state
Signed-out       | —                           | "Sign in to review" → stars.loginUrl()  | —                                      | —
```

The reviews empty state is a feature, not "No items found." It names the skill and
invites the first reviewer, with the write form already in view.

### User journey / emotional arc

```
STEP | USER DOES                    | FEELS                    | SUPPORTED BY
-----|------------------------------|--------------------------|----------------------------------------
1    | lands on ingredient page     | "is this any good?"      | ★ avg · N up top (5-sec visceral trust)
2    | reads a review or two        | "real people use this"   | light list, real avatars + logins
3    | clicks Preview on a card     | "what's inside?"         | modal SKILL.md, no navigation lost
4    | writes / edits their review  | "my take counts"         | inline form, optimistic, editable
5    | (future) sees it on profile  | "my reviews accrue"      | NOT built — future graph edge, noted
```

### Design-system alignment (no DESIGN.md — calibrate to `ex-*` + components)

- **★ not ◆ (ruling).** Reviews use the star glyph ★ (U+2605), matching `StarButton`
  and `ex-skillgroup-stars`. Do NOT use the ◆ gemstone `StoneRating` renders — that
  is a gem's *earned Stone grade*, a different concept; reusing it would make a crowd
  rating read as an earned grade.
- **Reviews render as a light list, not cards.** A review is `avatar(24px) · login ·
  ★rating · body · <time>` in an `<li>`, not a bordered card with an icon-in-circle
  (avoids the AI-slop card-grid look). No left-accent borders, no emoji.
- **Reuse:** `ex-card` (section shell), `ex-avatar` small variant (reviewer, like
  Profile's `ex-avatar-lg`), `ex-star` styling for the rating picker, existing button
  class for submit, `ex-empty` / `ex-error` for states, `ex-skill-body` `<pre>` for
  preview.
- **New classes** (add to `styles.css`, same token vocabulary): `ex-modal` +
  `ex-modal-panel` + `ex-modal-close`; `ex-reviews`, `ex-review`, `ex-review-meta`;
  `ex-review-form`, `ex-rating-input`. All colors via existing CSS variables; no new
  font stacks.

### Responsive & accessibility

- **Rating picker** = `role="radiogroup"` labelled "Your rating"; five `role="radio"`
  stars with `aria-checked`; keyboard: Left/Right arrows move, `1`–`5` set directly,
  visible focus ring; hover/focus previews the fill. Touch targets ≥44px on mobile.
- **Textarea** has a *visible* `<label>` "Your review" (never placeholder-as-label).
  Optional char counter is `aria-live="polite"`; the 4000-cap is enforced client + server.
- **Preview modal** = `role="dialog"` + `aria-modal="true"` + `aria-labelledby` (skill
  name); focus trapped inside; ESC and backdrop click close; focus returns to the
  Preview button that opened it. Panel `max-width: 640px`, full-width with padding on
  small screens; body scrolls inside the panel (`overflow:auto`), page does not.
- **Reviews list** is a `<ul>`/`<li>`; each date is `<time datetime>`. Reviewer meta
  is muted but stays ≥4.5:1 contrast. The `ex-skill-body` `<pre>` may stay mono ~13–14px
  (code exception to the 16px body-min).
- **Modal on mobile:** full-bleed sheet with 16px padding; close button ≥44px.

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
  - `Ingredient.test.tsx`: reviews section renders **first** (before "Used together
    with"); summary + list; **empty state** shows the "be the first" copy + form;
    signed-in shows the form and a submit posts; signed-out shows the sign-in prompt;
    edit prefills the caller's review; delete removes; **error state** on failed fetch.
  - `PopularSkills.test.tsx`: card renders `★ avg · N` from a stubbed summary; a
    **zero-count card renders no aggregate**; card name links to
    `/ingredient/skill:<name>`; Preview button opens the modal; modal shows a loading
    then the fetched content, and an error+Retry on failure.
  - `Modal.test.tsx`: opens with `role="dialog"`; closes on ESC / backdrop / close
    button; focus returns to the trigger.
  - `RatingInput.test.tsx`: `radiogroup` semantics; arrow keys and `1`–`5` set the
    rating; `aria-checked` reflects state.

## Build order

1. Backend: `reviews` schema + `reviews.ts` query module + tests.
2. Backend: `src/reviews/install.ts` routes + `originGuard` exemptions.
3. Marketplace client: `reviews.ts` + `App.tsx`/`Router` `ReviewsCtx` wiring.
4. Preview: `Modal.tsx` + card Preview button + test.
5. Card: aggregate rating + title→detail link.
6. Detail page: reviews section (summary + list + write form) + tests.
7. Full marketplace + aggregator suites + typecheck; live-browser verification.

## Implementation Tasks
Synthesized from the design-review findings. Each derives from a specific finding.

- [ ] **T1 (P1, human: ~2h / CC: ~20min)** — reviews backend — table + `reviews.ts` query module + routes
  - Surfaced by: spec §B — data model, query module, HTTP routes (mirror `stars`)
  - Files: `packages/aggregator/src/schema.ts`, `packages/aggregator/src/reviews.ts`, `src/reviews/install.ts`, `src/originGuard.ts`, `packages/aggregator/src/index.ts`
  - Verify: `src/aggregator/__tests__/reviews.test.ts` + `src/__tests__/reviewsInstall.test.ts` green
- [ ] **T2 (P1, human: ~45min / CC: ~10min)** — marketplace client — `reviews.ts` + `ReviewsCtx` wiring
  - Surfaced by: spec §B — Marketplace client; Router/App plumbing (parallel to `StarsCtx`)
  - Files: `packages/marketplace/src/reviews.ts`, `App.tsx`, `Router.tsx`
  - Verify: typecheck; ctx reaches `Ingredient` + `PopularSkills`
- [ ] **T3 (P1, human: ~1.5h / CC: ~15min)** — detail-page Reviews section (first) + states + a11y
  - Surfaced by: Pass 1 (order), Pass 2 (states), Pass 6 (radiogroup picker, visible label, contrast)
  - Files: `packages/marketplace/src/pages/Ingredient.tsx`, `RatingInput.tsx`, `styles.css`
  - Verify: `Ingredient.test.tsx` + `RatingInput.test.tsx` (empty/error/edit/delete, keyboard)
- [ ] **T4 (P2, human: ~1h / CC: ~10min)** — Preview modal + card wiring
  - Surfaced by: spec §A + Pass 6 (dialog focus-trap, ESC, return focus, mobile sheet)
  - Files: `packages/marketplace/src/Modal.tsx`, `pages/PopularSkills.tsx`, `styles.css`
  - Verify: `Modal.test.tsx`; Preview loads/errors in-browser
- [ ] **T5 (P2, human: ~30min / CC: ~5min)** — card aggregate `★ avg · N` (zero → nothing) + title→detail link
  - Surfaced by: Pass 1 (scan order, zero-state = subtraction) + card→detail graph edge
  - Files: `packages/marketplace/src/pages/PopularSkills.tsx` (+ test), `styles.css`
  - Verify: `PopularSkills.test.tsx` (aggregate shown, zero renders none, name links)

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | — | — |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | issues_open→resolved | score 5/10 → 9/10, 6 decisions |
| DX Review | `/plan-devex-review` | Developer-experience gaps | 0 | — | — |

Design passes: P1 IA 5→9 (reviews-first order), P2 states 4→9 (state table added),
P3 journey 6→9 (storyboard + first-reviewer beat), P4 slop 8→9 (list not cards),
P5 design-system 6→9 (★-not-◆ ruling, reuse map), P6 a11y 3→9 (radiogroup picker,
visible label, modal focus-trap, 44px targets), P7 the one decision resolved.

- **VERDICT:** DESIGN CLEARED — spec is design-complete (9/10). Eng review still required before ship.

NO UNRESOLVED DECISIONS
