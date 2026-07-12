# Profile hub — design (`/@handle` absorbs `/account` + `/groups` as tabs)

Date: 2026-07-12
Branch base: `origin/main` (`0a4d90fd`)
Status: approved design, pre-implementation
Package: `@agentgem/marketplace`

## Problem

`app.agentgem.ai/account` is a separate top-level page for account management (provider linking,
account merge, handle claim). The user's other personal surfaces are scattered: published gems and
reviews live on their public profile `/@<handle>`, org memberships are a section there, and native
groups (the just-shipped feature) are their own `/groups` page. This design consolidates all of a
user's surfaces into one tabbed hub at `/@<handle>`, moving `/account` and `/groups` into it.

## Decisions (settled during brainstorming)

1. **`/@<handle>` becomes a tabbed hub.** Tabs: `apps` (default), `reviews`, `orgs`, `groups`,
   `account`.
2. **Visibility split:** `apps` + `reviews` are **public**; `orgs` + `groups` + `account` are
   **owner-only** (gated on the existing `me.handle?.toLowerCase() === login.toLowerCase()`). A
   non-owner / signed-out viewer sees only the two public tabs. Requesting an owner-only tab a
   viewer can't see falls back to `apps`.
3. **Tabs are a `?tab=` query param** (`/@alice?tab=groups`), NOT a path segment. Reuses
   `useLocationSearch` + the `.ex-tabs`/`.ex-tab` pattern from `TeamUsage.tsx`. No new route shapes
   → `Router.conformance.test.tsx` is untouched, and `/@handle` stays the one shareable profile URL.
4. **`/account` and `/groups` become thin shims** that keep handle-less users working (see §D).
5. **No backend change** — the sole backend `/account` coupling (`src/account/connect.ts`'s OAuth
   redirect) is preserved; the shim forwards its query params onward.
6. **Absorb, don't duplicate** groups: the `/groups` list becomes the Groups tab body; `/groups`
   redirects there. `GroupDetail` stays at `/groups/:id`; the invite `?join=` flow keeps working.

## A. URL + tab model

- Active tab = `?tab=<id>` read via `useLocationSearch`; switching a tab calls `navigate` to the
  same `/@handle` path with the new `?tab=`. Mirrors `TeamUsage.tsx`'s `?range=` tabs exactly
  (`role="tablist"`, `role="tab"`, `aria-selected`, `.ex-tab.is-active`).
- Tab resolution: parse `?tab=`; if absent or not in the set, default `apps`; if the requested tab
  is owner-only and the viewer is not the owner, fall back to `apps`.
- Tab bar contents: the two public tabs always; the three owner-only tabs appended only when the
  viewer is the owner.

## B. Profile page structure (`pages/Profile.tsx`)

Header (avatar / `@login` / ✓verified / ★stars) stays above the tab bar. Below, the active tab body:

- **apps** — the published-gems list (moves verbatim from today's `Profile.tsx`).
- **reviews** — the reviews-written list (moves verbatim).
- **orgs** — the "Your orgs" section (moves verbatim; already owner-gated).
- **groups** — `<GroupsPanel me base />` (extracted, §C).
- **account** — `<AccountPanel api me base />` (extracted, §C).

`Profile` already receives `me`; it gains `base: string` (needed by the panels). The owner predicate
`isOwner = !!(me?.handle && me.handle.toLowerCase() === login.toLowerCase())` is computed once and
drives both the tab bar and the tab resolution.

## C. Component extraction

Extract the signed-in bodies of the two pages into reusable, self-contained panel components so both
the profile tab and the standalone shim can render them:

- **`pages/Account.tsx`** → export `AccountPanel({ api, me, base })` containing today's signed-in
  UI: provider list, Connect (Flow A `linkSocial`), merge (Flow B `absorbAccount` via the
  `?connect=`/`?error=` one-shot banners), and the `?merge=1&handle=` claim nudge. The one-shot
  query-param reads (`collision`, `connectStatus`, `mergeNudgeHandle`) and the `replaceState`
  strip stay inside the panel — they work identically whether the URL is `/account?connect=ready`
  or `/@handle?tab=account&connect=ready` (they read specific params, ignore the rest).
- **`pages/Groups.tsx`** → export `GroupsPanel({ me, base })` containing the list + create form +
  `?join=<token>` redeem effect.

Both keep their existing `!me` sign-in prompt for the signed-out standalone case; inside the profile
hub they only render for the owner, so `me` is always set there.

## D. `/account` and `/groups` shims (handle-less support)

Both routes collapse to the same three-way shim (a small wrapper component each):

- **Signed-in WITH a handle** → `navigate` to `/@<handle>?tab=account` (or `groups`), **carrying
  forward the incoming query string** (so `/account?connect=ready` → `/@handle?tab=account&connect=ready`
  and the Account tab's banner still fires). Renders nothing (redirect only).
- **Signed-in, NO handle** → render `<AccountPanel>` / `<GroupsPanel>` inline. Handle-less users
  (fresh Google accounts) have no `/@handle`, so this remains their surface. The `HandleClaim` 409
  nudge keeps targeting `/account`, where a still-handle-less user lands on the inline panel.
- **Signed-out** → the panel's own sign-in prompt (panels already render this when `!me`).

`GroupDetail` (`/groups/:id`) is unchanged.

## E. Navigation (`App.tsx`)

- The "Account" and "Groups" nav links (shown when `me`) point to `/@<handle>?tab=account|groups`
  when `me.handle` exists, else to `/account` / `/groups` (which render inline for the handle-less).
- The profile chip continues to link `/@<handle>` (lands on Apps).
- `is-active` styling on those nav links keys off `path.startsWith("/@")` + the `?tab=` value, or
  the fallback path — kept simple, matching the existing inline `on*` style.

## F. Backend

No change. `src/account/connect.ts:132` keeps `dest = ${publicBase}/account`; the shim forwards
`?connect=…` onward to the Account tab. Verified this is the only backend reference to the `/account`
path (all others are `/api/account/*`).

## G. Testing

- **Profile tabs:** signed-out/non-owner viewer sees exactly `apps` + `reviews` in the bar; owner
  sees all five; default tab is `apps`; a non-owner requesting `?tab=account` falls back to `apps`
  and never renders account controls; switching `?tab=` swaps the body.
- **Panels:** move `Account.test.tsx` / `Groups.test.tsx` assertions to target the extracted
  panels; the panels render their existing behavior (provider list, create-group, join).
- **Shims:** `/account` + `/groups` redirect to the tab when `me.handle` is set (assert `navigate`
  target incl. forwarded query params), render inline when `me.handle` is null, sign-in prompt when
  signed out.
- **Conformance:** `Router.conformance.test.tsx` stays green (no route-shape change; `account` and
  `groups`/`group-detail` route ids/kinds unchanged — only their render bodies become shims).
- Full gate: `pnpm --filter @agentgem/marketplace test` + `typecheck` + `build`.

## Rollout

Single package, one PR. Work on a fresh worktree off `origin/main`. Tasks: extract panels →
tab the profile → shim `/account` + `/groups` → nav retarget → green gate + PR.

## Out of scope (deferred)

- Any backend/API change (none needed).
- Path-segment tab URLs (`/@handle/groups`) — rejected for conformance + shareable-URL reasons.
- New profile content beyond re-homing what exists (no new sections/data).
- Console (desktop) — this is the public marketplace SPA only.
