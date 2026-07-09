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

## Extract the duplicated route preamble into a shared routeKit

**What:** `cors()`, `preflight()`, and `whoami()` / `sessionLogin()` are copy-pasted
across `src/catalog/install.ts:19-36`, `src/githubApp/orgsApi.ts:24-41`,
`src/usage/install.ts`, and `src/groups/install.ts` — four near-identical copies, plus
four hand-written `interface Req` / `interface Res` / `type ExpressApp` declarations.

**Why:** The copies have already diverged, and one divergence is a real bug.
`orgsApi.ts:35-41` accepts either a session cookie or `Authorization: Bearer`, while
`catalog/install.ts:32-36` reads only the cookie. So the CLI cannot call
`DELETE /api/catalog/gem` with a Bearer token, even though every other catalog-adjacent
route accepts one. Each `preflight()` also hardcodes its own `Allow-Methods` string.

**Pros:** One `routeKit.ts` collapses roughly 120 duplicated lines, fixes the Bearer
inconsistency, and makes the Req/Res shim a single type.

**Cons:** Touches four modules across two packages. A cross-cutting refactor bundled
into a feature PR hides the real change. Four differently-shaped modules is also thin
evidence for a shared abstraction — copy-paste twice before you abstract.

**Context:** Pre-existing pattern; the groups plan merely adds the fourth copy. The
Bearer gap at `catalog/install.ts:32-36` is the concrete motivating bug. Surfaced during
the 2026-07-08 eng review.

**Depends on / blocked by:** Nothing. Best done as its own PR, before or after the
groups plans.
