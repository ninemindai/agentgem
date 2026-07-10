# Identity Re-key: uuid Authorizes, Handle Names

**Status:** approved, not yet planned
**Depends on:** #255 (better-auth Plan 1a) and #256 (Plan 1b cutover) merged and deployed
**Blocks:** the multi-provider spec (Google/Slack/X, `linkSocial`, passkey)

## Goal

Make AgentGem's identity provider-agnostic, so that a second sign-in provider can be
added without breaking authorization, ownership, or referential integrity.

Today the GitHub `login` **string** is the de-facto identity. This spec moves every
authorization and ownership decision onto the `accounts.id` uuid, and demotes the
human-readable name to a `handle` used only for display, URLs, and gem scopes.

There is **no user-visible change** for existing users.

## Why this must land before any second provider

Two independent defects make a second provider unsafe today. Both were found by reading
the code, not by reasoning from the design.

### 1. The `accounts` anchor is GitHub-only, and it fails silently

`packages/aggregator/src/auth/betterAuth.ts:93` — `anchorAndScopes` opens with:

```ts
if (account.providerId !== "github") return;
```

A Google sign-in would therefore create a better-auth `user` row with **no `accounts`
anchor**. Ten tables carry a foreign key to `accounts.id`:

`web_sessions`, `handoff_codes`, `stars`, `reviews`, `account_scopes`, `usage_days`,
`usage_day_models`, `groups.created_by`, `group_members`, `group_invites.created_by`

The user's *first* authenticated write — starring a gem, leaving a review, creating a
group — violates the foreign key. None of those call sites catch it, so it surfaces as an
unhandled rejection and a 500, not a graceful denial.

### 2. `login` is load-bearing authorization, and it has no uniqueness constraint

`resolveSession` (`packages/aggregator/src/webAuth.ts:69`) returns `login: u.login ?? ""`.
A provider that supplies no login yields the identity `""`.

There is **no unique constraint** on `accounts.login`, `user.login`, or
`account_scopes.scope` anywhere in `ensureSchema`. GitHub logins are unique *upstream*, so
the schema never had to enforce it. Uniqueness that lives in an external system is a
borrowed invariant; it evaporates the moment a second source of identity exists.

The sharpest consequence is in `deleteCatalogGem` (`packages/aggregator/src/catalog.ts:73-81`):

```ts
if ((row.publishedBy ?? "").toLowerCase() !== ownerLogin.toLowerCase()) return "forbidden";
```

With two empty-login users, this evaluates `"" === ""` and **authorizes any such user to
delete any gem whose `published_by` is empty**.

## Decisions

### uuid authorizes, handle names

Ownership and access are decided by `accounts.id` (uuid). The handle is a display and URL
key that authorizes nothing.

The alternative — a unique, non-null handle carrying string-keyed ownership — was rejected
because it preserves the GitHub login rename/reuse attack: rename your handle, and whoever
claims the freed name inherits every gem whose `published_by` still reads it. Under uuid
authorization that attack is not expressible.

A pure uuid re-key (no handle at all) was rejected because gem keys and profile URLs are
public, human-readable strings — `raymond/my-gem`, `/@raymond`, `/orgs/ninemindai`. A
uuid-only scheme has to reintroduce a name-to-account lookup, which is the handle arrived
at the long way.

### The handle is nullable, and claimed lazily

Because the handle authorizes nothing, it need not exist. Postgres `UNIQUE` permits
multiple `NULL`s, so a user without a handle simply has no profile URL and cannot publish.
Every other authenticated action — starring, reviewing, joining a group, reporting usage —
is already uuid-keyed and works without one.

`NULL` is also not `''`, so the empty-string collision class becomes *unrepresentable*
rather than merely guarded against.

A handle is claimed at the first action that needs a public name: publishing, or wanting a
profile. Existing GitHub users' handles are backfilled from their login and are already
claimed, so they never see the flow.

### The self grant is derived from the handle, never stored

*(Added after the engineering review. The original design mirrored the handle into a
`role='self'` row in `account_scopes`; that mirror produced two reachable security defects,
described below.)*

`"user".handle` is the single source of truth for what an account is named. `accountSelfScope`
and `accountOwnsScope` read that column directly. **Nothing writes a `role='self'` scope row**,
and `ScopeGrant` does not admit the role, so reintroducing the mirror is a compile error.
`account_scopes` holds captured GitHub **org memberships only**.

The mirror had three writers — `anchorAndScopes` (web sign-in), `claimHandle` (rename), and
`recordBinding` (CLI bind) — and they did not agree. `recordBinding` wrote the raw GitHub
`login`, and `setAccountScopes` *replaces* the account's whole scope set. Consequences, both
reproduced against PGlite:

1. **A rename did not survive `agentgem bind`.** After renaming `alice` → `carol`, a bind
   reset the self grant to `alice`. If anyone had since claimed the freed `alice`, the renamer
   held a `self` grant on *that stranger's* namespace — `accountOwnsScope` is the publish gate
   — while losing the right to publish under `carol`. The rename/reuse attack this spec claims
   is "not expressible" *was* expressible, one table down.
2. **`GET /api/usage/org` skipped the App roster.** `usageDaysHandler` tested "is this scope my
   own name?" *before* calling `resolveOrgAccess`, so the roster-decides-alone rule never
   reached it. A handle squatting an org's name kept reading that org's usage dashboard after
   the org onboarded.

Deriving the grant removes the class, not just the two instances: there is no second copy to
drift, and a rename is a single `UPDATE` that moves ownership atomically. Every consumer of
"does this account own this scope?" now reads one column, and every consumer of "may this
caller see this org?" goes through `resolveOrgAccess`.

### Handle allocation is a security boundary, not a UX choice

User handles and GitHub org scopes share **one namespace** — the publish scope is either
your own handle or an org you belong to.

`uploadPublish` authorizes publishing via `accountOwnsScope(accountId, scope)`
(`src/registry/uploadPublish.ts:56`), and that function grants a scope the account's handle
names. So a user who could freely claim the handle `ninemindai` would thereby obtain the right
to publish gems under a GitHub org's scope — *for as long as that org has no active App
installation*, since an active installation routes publishing through `appOrgRole` instead.

`claimHandle` therefore performs a reserved-name check, and it is the only place that does.
It is a **namespace** guard, not the authorization boundary: `resolveOrgAccess`'s
roster-decides-alone rule is what actually revokes a squatter once the org onboards. Reserving
names an org has already touched narrows the window; it does not close it, and it cannot — the
org does not exist in our database until it interacts with us.

## Data model

Two new columns, one relaxed constraint, one dropped table. No new tables.

```sql
-- "user" (better-auth's table)
alter table "user" add column if not exists handle text;
create unique index if not exists user_handle_uniq on "user" (handle);
alter table "user" add constraint user_handle_shape
  check (handle is null or handle ~ '^[A-Za-z0-9-]{1,39}$');

-- catalog_gems: the authorization key
alter table catalog_gems add column if not exists owner_account_id uuid references accounts(id);

-- the anchor must accept a login-less user
alter table accounts alter column login drop not null;

-- dead since the Plan 1b cutover; zero readers
drop table if exists web_sessions;
```

`catalog_gems.published_by` is **kept**, demoted to a denormalized display string. It
authorizes nothing. Deleting it would mean rewriting the marketplace's author links, the
org-catalog trust filter, and the profile query in the same change, and it remains useful
as a display value that survives account deletion.

All DDL goes in `ensureSchema` (`packages/aggregator/src/schema.ts`), which stays the sole
idempotent authority — there is no drizzle-kit in this repo. Dropping `web_sessions` edits
the hardcoded alphabetized table list in `schema.test.ts`, which exists precisely to catch
an unannounced schema change.

`handle` lives on `"user"` while `owner_account_id` references `accounts(id)`. These are the
same uuid: `accounts.id === user.id` is guaranteed by the anchor hook and the Plan 1a
backfill. `resolveSession`'s `accountId` therefore indexes both tables, and no join is
needed to go from a session to an ownership check.

### The backfill must not mis-assign

Because `accounts.login` has no unique constraint, a naive
`where lower(a.login) = lower(cg.published_by)` can match more than one account and
silently assign the gem to whichever row the planner returns first. Assign only where
exactly one account matches:

```sql
update catalog_gems cg set owner_account_id = m.id
from (select lower(login) lg, min(id) id from accounts
      where login is not null
      group by lower(login) having count(*) = 1) m
where m.lg = lower(cg.published_by) and cg.owner_account_id is null;
```

Rows that do not resolve — a `published_by` naming an account that no longer exists, or a
login renamed after publishing — keep `owner_account_id = NULL`.

**Unresolved rows are owned by nobody.** The ownership predicate is:

```ts
owner_account_id !== null && owner_account_id === who.accountId
```

An unresolved gem cannot be unpublished by anyone, including a user whose login string
matches `published_by`. This fails closed. A string-compare fallback for NULL rows would
reintroduce the exact hole this spec closes. The boot backfill reports the unresolved
count; reassignment is a manual admin action.

## The authorization re-key

Ten call sites authorize on the `login` string. They fall into three groups.

### Two surfaces named `publishedBy`, and only one of them authorizes

This distinction is load-bearing, and easy to get wrong. `catalog_gems` — the marketplace
database table — has exactly **one writer in the whole repo**: `recordCatalogShare`
(`catalog.ts:126`), the signed CLI/desktop share path. Its `published_by` column is what
`deleteCatalogGem` checks, so it **authorizes**.

`publishGem`'s `publishedBy` argument is a different thing entirely. It flows into
`buildDiscovery` and lands in the **git registry index's JSON**
(`packages/distribute/src/registry.ts:217,270`). It is a public attribution string in a
file, touches no database row, and gates nothing.

Two consequences:

- **`src/registry/uploadPublish.ts` needs no ownership re-key.** It already authorizes with
  `accountOwnsScope(deps.db, who.accountId, scope)` (`uploadPublish.ts:55`) — uuid-keyed today.
- **`resolvePublishedBy` must keep returning a string, and that string becomes the `handle`**
  (`undefined` when unclaimed). A uuid in a public registry index names nobody.

### Ownership checks compare uuids

| Site | Change |
|---|---|
| `catalog.ts:73-81` `deleteCatalogGem` | string compare → `row.ownerAccountId !== null && row.ownerAccountId === who.accountId` |
| `src/catalog/install.ts:31-34` `sessionLogin` | becomes `sessionAccountId`; passes `who.accountId` |
| `catalog.ts:126` `recordCatalogShare` | resolves its binding to an `accountId`, writes `owner_account_id` |
| `profile.ts:64-88` `buildProfile` | resolves `handle → accountId`, lists gems by `owner_account_id` |
| `orgCatalog.ts:64-67` | trust filter's `ownerSet` becomes a set of `accountId`s, matched against `owner_account_id` |
| `src/registry/publishedBy.ts:21` | returns the `handle` (a string), not the `login` |

`buildProfile` and the org-catalog trust filter are **ownership reads**, not display reads. If
they kept matching on `published_by`, a profile page would list gems by string match — the
precise behavior this spec removes — and a gem with an unresolved `owner_account_id` would
still appear to belong to someone.

`account_bindings.account_id` is `text not null` (`schema.ts:397`) holding the **provider's**
account id, paired with `provider` to match `accounts(provider, provider_account_id)`. It is
*not* a uuid FK. `recordCatalogShare` therefore reaches an account by
`(provider, provider_account_id)` and must be given a uuid before it can populate
`owner_account_id`. If no `accounts` row resolves, it rejects with the existing
`"not-connected"` — you cannot own what the server cannot identify you as. This is a
deliberate tightening: `recordBinding` writes its `accounts` row best-effort, so a bind could
previously succeed without one.

### Self-scope checks look up the row, they do not compare strings

| Site | Change |
|---|---|
| `githubApp.ts:107` `resolveOrgAccess` | `who.login === scope` → uuid-keyed lookup for a `role='self'` row |
| `src/usage/install.ts:136,160` | personal-vs-org branch → same lookup |

This is what makes the shared namespace safe: claiming a name is no longer *itself* the
grant; holding the scope row is.

### GitHub-org checks are left alone, and fail closed

`memberRole` / `appOrgRole` read `org_members.gh_login`, the GitHub App's own roster. Orgs
remain GitHub-shaped, deliberately. A user with no GitHub identity matches no org, receives
no org role, and is denied. That is correct behavior, not a gap.

## Handle claim

```ts
claimHandle(db, accountId, handle):
  400 if !/^[A-Za-z0-9-]{1,39}$/            // charset
  409 if the handle is already taken         // arbitrated by the unique index
  409 if reserved: present in org_members.gh_login or as an org_settings scope
  -> update "user" set handle = $handle where id = $accountId
  -> replace the role='self' row in account_scopes with the new handle
```

`claimHandle` does **not** distinguish "taken" from "reserved". Both are true statements
about availability, and separating them tells a prober which GitHub orgs the App has seen.

The unique index is the race arbiter: a concurrent claim loses on the constraint, not on a
prior `SELECT`. This is the same TOCTOU discipline as `removeMemberGuarded` in the groups
work.

### Rename is safe by construction

Renaming a handle updates the `role='self'` scope row and leaves `owner_account_id`
untouched. Gems follow the account, not the name, and the freed handle carries no ownership
to whoever claims it next.

## Anchor generalization

`anchorAndScopes` loses its `if (account.providerId !== "github") return` guard. For any
provider it writes the `accounts` anchor with `login = NULL`; it derives a login and
captures org scopes only for GitHub.

This is what makes the ten `accounts.id` foreign keys satisfiable for a login-less user,
and it is testable **today**, against a fake provider, before any real provider exists.

The eight display sites that read `accounts.login` — `profile.ts`, `orgCatalog.ts`,
`usageDays.ts`, `groups.ts`, `reviews.ts`, `projectAdoption.ts` — render
`coalesce(login, handle, name)`.

## Failure modes

| Condition | Behavior |
|---|---|
| Gem with unresolved `owner_account_id` | Unpublishable by anyone. Fails closed. |
| Two accounts share a login | Both their gems stay unresolved. No mis-assignment. |
| Concurrent claim of the same handle | One wins on the unique index; the other gets 409. |
| Claim of a name matching a known org | 409, indistinguishable from "taken". |
| Profile requested for a handle nobody holds | 404. `buildProfile` resolves handle → accountId; no account, no page. |
| Handle-less user's own profile | Does not exist. There is no URL that names them until they claim. |
| Login-less user attempts to publish | Routed to the claim flow. |
| Non-GitHub user in an org-gated route | Matches no `gh_login`, denied. Correct. |

## Testing

PGlite against the real `ensureSchema` DDL, per repo convention. Aggregator store code
lives in `packages/aggregator/src/`; its tests live at `src/aggregator/__tests__/` and
import `@agentgem/aggregator`. Tests run against compiled `dist/`.

The tests that would actually catch a regression:

1. An unresolved gem cannot be unpublished by anyone, **including** a user whose login
   string equals its `published_by`. If the string fallback ever creeps back, this fails.
2. Two accounts sharing a login leave both gems unresolved rather than mis-assigning either.
3. Claiming a handle equal to a known org scope is rejected — the escalation guard.
4. Renaming a handle preserves gem ownership; re-claiming the freed handle grants nothing.
5. The anchor writes an `accounts` row for a **fake non-GitHub provider** with
   `login IS NULL`, and a subsequent `stars` insert against that account succeeds — proving
   the ten foreign keys are satisfiable before any real provider exists.
6. `claimHandle` rejects `''`, `NULL`, and out-of-charset input at the DDL level, not only
   in application code.

## Non-goals

Recorded with reasons, so they stay decided.

**Google, Slack, X, `linkSocial`, passkey.** The next spec. Additive once this lands,
because every invariant they would have broken is fixed here.

**ed25519 signed provenance and royalty attribution.** A pubkey proves *possession*, not
identity — the codebase already says so at `catalog.ts:108-111`. The keypair is generated
lazily on first CLI use and written to a local file (`packages/model/src/identity.ts:44-62`),
so it is a **per-device credential, born anonymous**: `producers.pubkey` rows exist with no
binding at all, and `recordBinding` is a *server assertion* that a key belongs to an
account, not a cryptographic fact about the key. It follows that (a) browser sign-ups have
no key, (b) one user holds many keys — `account_bindings.pubkey` is the primary key, one
row per machine — so publishing from a laptop and unpublishing from a desktop would fail,
and (c) key loss would mean ownership loss unless the account can recover it, in which case
the account was the root of trust all along.

`accountId` is the only key reachable from **both** publish paths: CLI publish hops
`pubkey → account_bindings → account`; web publish goes `session → account`.

Signed authorship remains worth building, as a purely additive `published_by_pubkey` plus
an archive signature — columns that authorize nothing. The claim it would make is not "gem
authored by key K" but "gem authored by a **device bound to account X**", which still roots
in `accountId`. That is the seam royalties will key off, and this spec does not foreclose it.

**Collapsing `accounts` into `"user"`.** `accounts.id === user.id` is already guaranteed by
the anchor and the Plan 1a backfill, so the collapse is a pure foreign-key repoint with zero
semantic change, safe at any later time. Doing it here would double the diff of an already
risky migration.

**Re-keying orgs away from GitHub.** `org_members.gh_login` stays the GitHub App's roster.

**Handle/org-namespace squatting.** Handles and GitHub org names share one namespace
(`isReserved` in `handles.ts` blocks a claim matching a row already in `org_members` or
`org_settings`), so a user can still claim the handle of a GitHub org that has not yet
onboarded — `isReserved` has nothing to check until the org's first installation or settings
write exists. Post-onboarding, this grants **no authorization** over the org: `resolveOrgAccess`
resolves an active installation first, so the App-synced roster decides membership alone and
the squatted handle is never consulted (final-review Finding 1); publishing is
already gated by `appOrgRole`, not by `self`, whenever an installation is active.

> **This claim is conditional, and the condition is load-bearing.** It holds only because every
> caller that asks "may this session act on this scope?" routes through `resolveOrgAccess`. The
> engineering review found that `usageDaysHandler` did not — it short-circuited on a self check
> ahead of the gate, and leaked the org's usage dashboard to a pre-onboarding squatter. Any new
> handler that re-derives "is this my own scope?" instead of reading `resolveOrgAccess`'s
> `via === 'self'` verdict silently reopens this hole. The gate is the invariant; the sentence
> above is only its consequence.

What remains
is ordinary username-registry squatting: `/@<org>` resolves to the squatter's profile, not the
org, and any gems the squatter published under that scope before the org onboarded still render
on the org's catalog page. Closing that means seizing or re-assigning a name already in active
use — a product decision with support consequences (who gets notified, what happens to the
squatter's gems), not a code fix. Out of scope here.

This gap is newly reachable, not newly present: before the re-key, `self` was `who.login ===
scope`, and GitHub's user and org namespaces are already shared upstream, so a login could never
equal an org name — the collision was structurally impossible. Severing self-scope from the
login (see "Self-scope checks look up the row, they do not compare strings" above) dropped that
inherited guarantee; it was never a guarantee this design chose to provide.

## Rollout

1. Merge and deploy #255, then #256. This spec presumes better-auth is authoritative and
   `resolveSession` returns a uuid `accountId`.
2. Deploy this migration. `ensureSchema` runs the DDL and the backfill idempotently at boot.
3. Read the unresolved-row count from the boot log. Reassign manually if non-zero.

No forced re-auth. No UI change for existing users. The only new surface is a claim flow
that no user can reach until the next spec ships.
