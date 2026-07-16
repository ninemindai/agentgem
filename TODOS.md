# TODOS

Deferred work, with enough context to pick up cold.

## Theme-wide: muted small-text contrast is below WCAG 4.5:1

**What:** Decide whether `--muted` (#8a7f69) on `--raised` (#fbf7ee) at 11–12px —
used for `obs-usage-count`, legends, metadata lines across the Observe dashboard —
should be darkened (e.g. toward `--ink-soft`) or the small-text sizes bumped.

**Why:** WCAG AA wants ≥4.5:1 for body-size text; the muted-on-raised pair sits
below that. Flagged during the 2026-07-16 design review of the Overview
token-breakdown cards, but it's a theme convention, not a per-card issue — fixing
one card would fork the design language.

**Pros:** One token change fixes contrast everywhere at once; keeps every card
consistent.

**Cons:** Darkening `--muted` changes the whole page's texture — the warm
letterpress look depends on the quiet metadata layer; needs a designer's eye pass,
not a mechanical swap.

**Context:** Tokens in `packages/console/src/shell/theme.css:14` (`--muted`) and
the `obs-*` rules around line 1040. Verify candidate values against both `--paper`
and `--raised` backgrounds.

**Depends on / blocked by:** Nothing. Theme-level decision.

## Null-project ("Unassigned") filterability on Observe

**What:** Teach `ObserveFilter`/`aggregateObserve`/the project `<select>` a
`project: null` value so the "Unassigned" bucket in "Tokens by project" becomes
clickable like every other row.

**Why:** Deferred from the 2026-07-16 token-breakdown design review (decision 9A):
today "Unassigned" renders as an honest non-link. If a user's sessions are mostly
projectless, their top spender is a row they can't drill into.

**Pros:** Removes the one dead end in the token-attribution flow.

**Cons:** Touches shared filter plumbing (`ObserveFilter` type, `aggregateObserve`
filter application, `ObserveFilters` select) also used by Sessions; a sentinel
value for "null" needs care in the select's empty-string convention.

**Context:** Filter application at `packages/insight/src/observeAggregate.ts:86`;
select at `packages/console/src/panels/Observe/ObserveControls.tsx:31-35`. Only do
this if the Unassigned bucket proves dominant in real usage.

**Depends on / blocked by:** The token-breakdown cards shipping first.

## Key federated membership on GitHub's numeric user id, not the login string

**What:** Add `gh_user_id` to `org_members` and match accounts on
`accounts.provider_account_id` (which already stores GitHub's numeric id) instead of
`lower(accounts.login)`.

**Why:** GitHub logins are mutable. A member who renames their GitHub account becomes
unmatchable: `accountIdForLogin('oldname')` returns null, the `member_removed` webhook
for their old login silently no-ops, and their `via_sync` grant goes stale. An
offboarded member who renamed keeps group access until their captured scopes expire.

**Pros:** Removes the last mutable-string join from the membership path.
`provider_account_id` is already stored and already unique per provider.

**Cons:** `org_members` is populated from GitHub's roster API; changing it means a
backfill and a webhook payload change. Same debt the `account_identities` split will
confront anyway.

**Context:** Two call sites — `accountIdForLogin` in
`packages/aggregator/src/groupsFederation.ts`, and the `member_added` / `member_removed`
branches in `src/githubApp/sync.ts:95-102`. Target key is `accounts.provider_account_id`
(`packages/aggregator/src/schema.ts:81`). Surfaced by the Codex outside voice during the
2026-07-08 eng review of the groups plan. Mitigating factor: it self-heals on the
member's next sign-in, because `captureOrgMemberships` re-materializes their grant under
the new login.

**Depends on / blocked by:** Nothing blocking. Naturally belongs with the
`account_identities` sequel, which re-keys identity anyway.

## Fix the catalog cookie-only Bearer gap

**What:** `catalog/install.ts` resolves the session from the cookie only, while every
sibling public route (`orgsApi`, `usage`, `groups`, etc.) accepts either a session
cookie or `Authorization: Bearer` via `resolveSession`. So the CLI cannot call
`DELETE /api/catalog/gem` (or the catalog reads) with a Bearer token.

**Why:** A real inconsistency bug on an auth path — the CLI can publish/unpublish
everywhere except catalog. The fix is one line: route catalog's session lookup through
`resolveSession(auth, req.headers)` like the others (add a regression test:
`DELETE /api/catalog/gem` with a Bearer token → 200).

**Pros:** Closes a documented bug; makes the catalog auth surface uniform with its
siblings; ~one-line change plus a test.

**Cons:** Widens catalog's accepted auth (cookie → cookie|Bearer). Intended, but must be
tested so it's owned, not accidental.

**Context:** The CORS/`preflight`/type-shim dedup half of this (originally "shared
routeKit") shipped as Fix 1 — `src/publicCors.ts`, PR #371. The *controller migration*
that would have folded this in (Fix 3) was reviewed and SHELVED on 2026-07-12
(`docs/superpowers/specs/2026-07-12-public-api-framework-migration-design.md` — the
framework-native path breaks the flat `{error:"..."}` envelope). So this Bearer bug is
now a standalone fix, not blocked on any migration.

**Depends on / blocked by:** Nothing. Its own small PR.

## Author a console DESIGN.md (design-system doc)

**What:** Write DESIGN.md for `packages/console` documenting the theme.css token
system (`--ink`/`--paper`/`--accent`/`--line`), the `play-*` component vocabulary,
and surface rules (e.g. one terracotta primary per surface; segmented control for
single-choice groups; visible labels, placeholder is a format hint only).
`/design-consultation` can drive it.

**Why:** The 2026-07-15 Studio toolbar design review had to reverse-engineer the
design system from theme.css. A DESIGN.md lets future design reviews calibrate
against stated rules instead of inference.

**Pros:** Faster, more consistent design reviews; "one primary per surface" becomes
written law instead of oral tradition; onboarding aid.

**Cons:** ~an hour of documentation; risks staleness if not maintained.

**Context:** Flagged during /plan-design-review of
`docs/superpowers/specs/2026-07-15-studio-toolbar-declutter-design.md`. The token
system already behaves like a design system; it's just undocumented.

**Depends on / blocked by:** Nothing.
