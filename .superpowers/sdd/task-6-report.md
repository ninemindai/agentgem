# Task 6 Report: chip shows `name` + conditional `/@handle` link, plus me.login sweep

## What changed

### 1. Chip (brief Steps 1-5)
- `packages/marketplace/src/App.tsx` (authed identity block, ~lines 74-83): the `<a className="ex-me" href={`/@${me.login}`}>` unconditionally rendering `me.login` is now conditional on `me.handle`:
  - `me.handle` truthy → `<a className="ex-me" href={`/@${me.handle}`}>` wrapping `me.name`.
  - `me.handle` null → `<span className="ex-me" title="Claim a handle from Publish to get a profile page">` wrapping `me.name` (no link).
- `packages/marketplace/src/App.test.tsx`: added the brief's two new tests verbatim ("chip: a handle-less (Google) user shows their name and NO profile link" and "chip: a handled user's name links to their /@handle profile"). Also updated the pre-existing "shows the login + Sign out when authenticated" test's stub: added `handle: "octocat"` per the brief's Step 4 note, **and** `id: "u0"` — `getMe()` in `auth.ts` gates on `u.id` (`if (!u?.id) return null`), so without an `id` the stub resolves to a signed-out `me === null` and the test fails outright (not just the `/@` assertion). This wasn't called out in the brief but was required to make the existing test pass, per the task's explicit instruction to do so.

### 2. `me.login` sweep (ADDITIONAL SCOPE, authoritative)
- `packages/marketplace/src/pages/Gem.tsx:90` — owner gate: `me.login.toLowerCase() === publishedBy.toLowerCase()` → `me.handle && me.handle.toLowerCase() === publishedBy.toLowerCase()` (handle-less users own nothing published). Comment above (server re-checks ownership) left untouched.
- `packages/marketplace/src/pages/Gem.test.tsx`:
  - Both `me={{ login: ... }}` fixtures (owner/non-owner cases) updated to `{ id, name, handle, avatarUrl: null, orgs: [] }`, keyed on handle.
  - Renamed the owner test's title to "...signed-in handle matches publishedBy...".
  - Added a third test: a signed-in user with `handle: null` does NOT see Unpublish against `apiOwned` (proves the `me.handle &&` guard).
- `packages/marketplace/src/pages/Profile.tsx:38` — own-profile orgs gate: `me.login === p.login` → `me.handle && me.handle.toLowerCase() === login.toLowerCase()` (compares the viewer's handle against the route's `/@<handle>` prop, NOT `p.login`, per the brief). `p.login` and the `ProfileT`/`profile` fixture untouched — only `Me` lost `login`.
- `packages/marketplace/src/pages/Profile.test.tsx`: both `me={{ login: ... }}` fixtures updated to `{ id, name, handle, avatarUrl: null, orgs }`. Assertions unchanged.

`Publish.tsx` / `Publish.test.tsx` were NOT touched (Task 7).

## Test results

```
pnpm -C packages/marketplace exec vitest run src/App.test.tsx src/pages/Gem.test.tsx src/pages/Profile.test.tsx
```
→ **3 test files passed, 32 tests passed** (App.test.tsx 11, Gem.test.tsx 12, Profile.test.tsx 9 — includes the 3 new tests: 2 chip tests + 1 handle-less-Unpublish test).

## Typecheck

```
pnpm -C packages/marketplace exec tsc --noEmit 2>&1 | grep -E "App\.tsx|Gem\.tsx|Profile\.tsx"
```
→ **no output** (clean). Remaining errors are exactly the expected Task 7 scope:
```
src/pages/Publish.test.tsx(12,45): error TS2353: Object literal may only specify known properties, and 'login' does not exist in type 'Me'.
src/pages/Publish.tsx(9,42): error TS2339: Property 'login' does not exist on type 'Me'.
```

## Concerns
- The pre-existing "shows the login + Sign out when authenticated" App.test.tsx stub needed an `id` field added (not just `handle`, as the brief's Step 4 note said) because `getMe()` gates on `user.id` being present — a gap in the brief, fixed to satisfy "make that test pass."
- `.superpowers/sdd/task-5-report.md` shows as modified in `git status` in this working tree but was NOT touched by this task — left out of the commit; appears to be leftover from a prior task's session.
- This file previously contained an unrelated report (an aggregator `POST /api/handle` route task, apparently from a different task-numbering context/session on this repo). That content has been replaced with this task's actual report, per the brief's explicit instruction to write this task's report to this path.
