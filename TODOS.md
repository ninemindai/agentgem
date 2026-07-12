# TODOS

Deferred work, with enough context to pick up cold.

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
