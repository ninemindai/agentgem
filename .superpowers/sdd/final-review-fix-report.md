# Final whole-branch review fixes

Fixes for the three final-review findings on `feat/identity-rekey`.

## Finding 1 (CRITICAL) — App-authoritative membership must preempt a squatted self row

### New precedence order

`resolveOrgAccess` (`packages/aggregator/src/githubApp.ts`) now checks, in order:

1. **App-authoritative** — an active (non-suspended) installation for `scope` decides
   membership ALONE via `memberRole`: in `org_members` → `{status:"ok", role, via:"app"}`,
   otherwise `{status:"none", role:null, via:"app"}`. Neither `account_scopes` nor a
   `role='self'` row is consulted.
2. **self** — `accountSelfScope(db, who.accountId, scope)` → `{status:"ok", role:"self",
   via:"self"}`. Reached only when there is no active installation for `scope`.
3. **Captured `account_scopes`** — unchanged, with the freshness TTL. Reached only when
   there is no active installation and no self row.

### Why

`claimHandle`'s `isReserved` (`packages/aggregator/src/handles.ts`) only rejects a handle
that matches an org already present in `org_members` or `org_settings` — i.e. an org that
has already installed the App or written settings. A GitHub org that has not yet onboarded
is a freely claimable handle. Under the old order (self checked first), a squatter's
`role='self'` row for that name would keep granting `self` forever, surviving the org's
later installation — path 1 (self) returned before path 2 (App) ever ran. Swapping the
order so the App roster is checked first closes that: once an installation exists, it
decides alone, and the squatted self row is simply never reached.

The doc comment above `resolveOrgAccess`, and the file-header comment, are rewritten to
describe the new order and the reason self no longer preempts the App path. Voice/density
matched to the original — not a full rewrite of the block. `memberRole`, `installationForScope`,
`accountScopeStatus`, `accountScopeRole`, `accountScopeInfo`, and `accountSelfScope`'s
case-insensitivity are all untouched.

### What I found in `src/usage/install.ts`

`isSelfScope` (`accountSelfScope` called directly, not through `resolveOrgAccess`) is used
in exactly one place: `orgUsageHandler`'s GET `/api/usage/org`, to decide whether the caller
is viewing their *own* personal dashboard (skips `memberGate` and the org's
`dashboardEnabled` visibility toggle entirely). It is never used to gate a write — the PUT
`/api/usage/settings` write path goes exclusively through `memberGate` → `resolveOrgAccess`.

Confirmed: after the precedence fix, a squatter holding `role='self'` on an org name that
has since installed the App gets `status:"none"` from `resolveOrgAccess`, so `memberGate`
403s them and `putOrgSettings` is never reached. **No genuine org-settings write is
reachable by a squatter after this change.**

Residual (read-only, not a write, and explicitly out of scope per the brief): a squatter's
`isSelfScope` check in `orgUsageHandler` still returns `true` for their squatted scope
regardless of installation state, since it doesn't call `resolveOrgAccess`. If usage
reports get attributed to that scope, the squatter could read that scope's usage stats
without being an org member. This is a personal-dashboard determination, not an org grant,
and the brief said it may stay as-is — flagging it here for the record, not fixing it.

### Discrimination experiment

Temporarily restored the old order (self-check first) in `packages/aggregator/src/githubApp.ts`,
rebuilt (`pnpm exec tsc -b`), and ran the new test:

```
 ❯ dist/aggregator/__tests__/githubAppStore.test.js (15 tests | 1 failed) 8938ms
     × App-authoritative membership preempts a squatted self row: role='self' on 'acme' does not survive the org's later installation

 FAIL  dist/aggregator/__tests__/githubAppStore.test.js > resolveOrgAccess > App-authoritative membership preempts a squatted self row: role='self' on 'acme' does not survive the org's later installation
AssertionError: expected { status: 'ok', role: 'self', …(1) } to deeply equal { status: 'none', role: null, …(1) }

- Expected
+ Received

  {
-   "role": null,
-   "status": "none",
-   "via": "app",
+   "role": "self",
+   "status": "ok",
+   "via": "self",
  }

 Test Files  1 failed (1)
      Tests  1 failed | 14 passed (15)
```

Restored the fix, rebuilt, reran:

```
 Test Files  1 passed (1)
      Tests  15 passed (15)
```

### New tests (`src/aggregator/__tests__/githubAppStore.test.ts`, `resolveOrgAccess` describe block)

- `App-authoritative membership preempts a squatted self row...` — a `role='self'` row for
  `acme`, where `acme` has an active installation and the holder is NOT in `org_members`,
  gets `{status:"none", role:null, via:"app"}` — the escalation, denied.
- `the same squatted self row still grants self when the org has no active installation` —
  same holder, no installation, still gets `{status:"ok", role:"self", via:"self"}`.
- `a suspended installation behaves as uninstalled: the squatted self row is granted again`.
- `a genuine org member with an active installation still gets their App role, unaffected
  by a squatter's self row` — `via:"app"`, unchanged.

## Finding 2 (Minor) — concurrent boot can abort on the index swap

`packages/aggregator/src/schema.ts` (~line 605): `drop index user_handle_uniq` had no
`if exists`. Two boots racing the one-time case-sensitive→case-insensitive migration both
pass the staleness check on their own snapshot; the first boot to actually drop it wins,
and the second's unguarded `drop index` then throws (no such index) and aborts that boot.
Fixed:

```ts
await db.execute(sql`drop index if exists user_handle_uniq`);
```

No dedicated test added — this is a one-line idempotency fix to `ensureSchema`, and the
brief's Tests section scoped new tests to Finding 1 only.

## Finding 3 — residual documented in the spec

Appended a new entry to the **Non-goals** section of
`docs/superpowers/specs/2026-07-09-identity-rekey-design.md`, alongside the existing "Re-keying
orgs away from GitHub" entry: handles and GitHub org names share one namespace, so a user can
still claim the handle of an org that hasn't onboarded; after Finding 1's fix this grants no
authorization once the org installs the App (the roster decides alone, and publishing is
already gated by `appOrgRole`); what remains is ordinary username-registry squatting
(`/@<org>` resolves to the squatter, and gems published under that scope before onboarding
still render on the org's catalog page); closing it needs a namespace-reservation policy — a
product decision, not a code fix; and a note that this is newly *reachable*, not newly
*present* — the old `self === login-string-match` design made the collision structurally
impossible via GitHub's shared user/org namespace, an inherited guarantee this design didn't
choose to provide.

## Verify

`pnpm clean && pnpm exec tsc -b` — clean build, zero errors.

Targeted run (`resolveOrgAccess`, usage routes, publish gate, handles):

```
pnpm exec vitest run \
  dist/aggregator/__tests__/githubAppStore.test.js \
  dist/__tests__/usageInstall.test.js \
  dist/registry/__tests__/uploadPublish.test.js \
  dist/registry/__tests__/publishedBy.test.js \
  dist/handles/__tests__/install.test.js \
  dist/aggregator/__tests__/handles.test.js \
  dist/aggregator/__tests__/schema.test.js

 Test Files  7 passed (7)
      Tests  90 passed (90)
```

Full suite:

```
pnpm test

 Test Files  1 failed | 382 passed | 3 skipped (386)
      Tests  1 failed | 2398 passed | 5 skipped (2404)
```

The only failure is the known pre-existing `consoleMount` boot-splash harness quirk
(`dist/__tests__/consoleMount.test.js > UI routing > serves the React console at / and /console`
— expects `class="boot-splash"`, gets the "console not built" placeholder because this
worktree never ran the console build). Not a regression from this change.

## Concerns

None on correctness. `.superpowers/sdd/task-5-report.md` and `.superpowers/sdd/task-9-report.md`
were already modified in the working tree before this task started (pre-existing dirty state
from a prior session) — left untouched and out of this commit, same as the precedent noted in
`task-9-report.md`.
