# Groups and Private Gems

**Date:** 2026-07-08
**Status:** Design approved, implementation plan pending
**Diagram:** `2026-07-08-groups-and-private-gems-architecture.html` (this directory)

## Problem

A gem is either published to the world or not published at all. There is no way for
a team to share a gem with its members, and no way for a group of friends to share
one among themselves.

The system does have an org concept, but it is not a group model — it is a GitHub
org model. `resolveOrgAccess` (`packages/aggregator/src/githubApp.ts:104`) matches a
GitHub username against `org_members.gh_login`, populated by the GitHub App webhook
sync. The only way to be in a group is for GitHub to say so. A team that lives on
Slack cannot form one; a group of friends cannot form one at all.

## Motivating users

Two segments, one mechanism:

- **Enterprise** — a team wants gems visible to the team and nobody else, and wants
  a contractor who is not in their GitHub org to see them too.
- **Consumers** — a few people who know each other want to share gems privately.

These differ only in where membership comes from. They are not two features.

## Non-goals

Each is a separate spec, deliberately deferred:

- Splitting `account_identities` out of `accounts` to support multiple login providers.
- Google OIDC (or any new login provider). GitHub remains the only identity root.
- Slack as a second federated membership source. The design admits one; this spec
  does not build it.
- Re-keying `catalog_gems.published_by` off the bare GitHub login string.
- Pretty slugs for native groups. They are uuid-addressed.
- Usage dashboards for native groups. See "Why usage stays federated-only" below.

## Design

### Two group kinds

```
groups          id uuid pk
                kind        'federated' | 'native'
                scope       text unique null      -- verified external name
                name        text
                created_by  uuid → accounts.id
                created_at  timestamptz
                CHECK ((kind = 'federated') = (scope IS NOT NULL))
```

A **federated** group mirrors an external network. It has a `scope` — a name proven
by an external authority (today, a GitHub App installation on the `acme` org). A
**native** group is created inside AgentGem, has no scope, and is addressed by uuid.

`scope IS NOT NULL` is exactly the predicate "this group's name was verified by an
external authority." That is why the check constraint ties it to `kind`.

Native groups get no globally-unique name. This is the point: a name registry would
mean a user could create a group called `acme` and squat the namespace the real Acme
needs when they install the GitHub App. Only names that were *earned* are unique.

### Two membership sources

```
group_members   group_id    uuid → groups.id
                account_id  uuid → accounts.id
                role        'admin' | 'member'
                source      'sync' | 'invite'
                added_at    timestamptz
                pk (group_id, account_id)
```

`source` is the load-bearing column. The GitHub App reconciler's delete predicate
becomes:

```sql
DELETE FROM group_members WHERE group_id = ? AND source = 'sync'
```

This is what lets an invited contractor coexist with GitHub-authoritative
offboarding. Removing someone from the GitHub org evicts their `source='sync'` row
within seconds of the webhook, preserving the guarantee documented at
`githubApp.ts:90-103`. An invited guest was never GitHub's to revoke, and is
individually listed, admin-created, and individually removable.

`kind` and `source` are orthogonal. A federated group may hold invited guests. A
native group holds only invited members.

### Invites

```
group_invites   token_hash  text pk        -- sha256 of the raw token; raw never stored
                group_id    uuid → groups.id
                role        'admin' | 'member'
                expires_at  timestamptz
                created_by  uuid → accounts.id
                revoked_at  timestamptz null
```

Multi-use until expiry or revocation. This deliberately differs from
`handoff_codes`, which is delete-on-read: a handoff code is a machine-to-machine
one-shot, whereas a group invite is a link pasted into a chat and clicked by several
people. The storage discipline is copied (sha256 only, opportunistic expiry sweep,
see `redeemHandoffCode` at `packages/aggregator/src/webAuth.ts:68`); the lifecycle is not.

Only a group admin may mint an invite. Redeeming requires a session; a signed-out
visitor logs in first and returns to the redeem URL.

### Gem visibility

```
catalog_gems  + visibility text not null default 'public'   -- 'public' | 'private'

gem_shares      gem_key   text
                group_id  uuid → groups.id
                pk (gem_key, group_id)
```

A private gem names one or more groups. Enterprise "share with my org" is a UI
default (preselect the user's federated group when there is exactly one), not a
separate mechanism.

Publishing rejects any target group the publisher is not a member of.

### The gate

One function, the only place membership is interpreted:

```
canReadGem(accountId, login, gemKey)
  = visibility = 'public'
  OR EXISTS (gem_shares ⋈ group_members WHERE group_id matched AND account_id = ?)
  OR published_by = login          -- owner fallback
```

The owner clause reuses the login-string comparison that `deleteCatalogGem` already
performs (`src/catalog/install.ts:42`). It is needed because deleting a group
cascades its `gem_shares` away, and a private gem shared with zero groups must remain
visible to whoever published it. This inherits the bare-login-string debt, but
inherits it *consistently* with existing code rather than adding a second, divergent
notion of ownership. The `published_by` re-key sequel fixes both call sites at once.

Because the gate is computed live against `group_members`, removing someone from a
group instantly revokes every private gem shared with it. There is no grant to
expire and no cache to invalidate.

## Two read surfaces, not one filter

This is the central decision.

Twelve gem-read routes sit in `PUBLIC_READ_PATHS` (`src/originGuard.ts:36`) and are
served with `Access-Control-Allow-Origin: *`. With a wildcard ACAO the browser does
not send cookies, so `app.agentgem.ai` calls `api.agentgem.ai` with no credentials by
design. `AggregatorController` injects only `db` (`src/aggregator.controller.ts:151`)
and cannot see the caller at all.

The tempting design is to make private gems a *filtered view* of the public catalog.
That is the expensive, leaky one: each of the twelve routes becomes a place to forget
a predicate, and `publicGemCache` (`src/gem/publicCatalog.ts:80`, global, 5-minute
TTL) could never be per-user.

Instead:

- **Public routes** carry an unconditional `WHERE visibility = 'public'`. The
  predicate never depends on the caller, so it cannot be wrong per-user.
  `publicGemCache` stays global and identity-free because no private row can enter it.
  `PUBLIC_READ_PATHS` is not modified.
- **Private gems** are served from new routes under `/api/catalog/*`, which already
  has credentialed CORS against the origin allowlist (`src/catalog/install.ts:19-26`)
  and already resolves a session (`:34`). No new CORS config, no new DI.

A leak then requires *adding a route*, not *forgetting a filter*.

## Write-side guards

Three channels the read gate cannot see:

1. **Registry publish.** `/api/registry/*` and the MCP `registry_*` tools read and
   write the **public GitHub registry repo**, not `catalog_gems`. A private gem
   published there would leak through a door the visibility column does not guard.
   `uploadPublish` and `registry_publish` reject `visibility = 'private'`.

2. **Aggregate endpoints.** `/effectiveness`, `/gem-adoption`, `/adoption`,
   `/popularity`, `/co-occurrence*`, `/benchmarks` expose gem **names and keys** via
   k-anonymized rollups over usage tables. A private gem adopted by ≥ k producers
   would surface its name. These exclude any `gem_key` with a private catalog row.
   Disclosure of a name is disclosure, even without the bytes.

3. **Archive bytes.** `/api/aggregator/gem-archive` **stays public** and gains a join
   on `visibility = 'public'`. Private bytes are served only from a new
   `/api/catalog/gem-archive` behind the session. Old `agentgem get` binaries keep
   working unchanged and can never fetch private bytes — this is not a breaking change.

## Data flow

**Publish private.** The publish form gains a visibility toggle and a group picker.
`recordCatalogShare` writes `visibility`, then inserts `gem_shares`. Insert order is
load-bearing: the gem row is written `private` *before* its shares exist, so the
window is owner-only. Shares-first-then-flip would expose a public, already-shared
window. This ordering needs a comment in the code.

**Read entitled.** Credentialed `/api/catalog/gems` → `resolveSession` → `accountId`
→ `canReadGem`. Detail and archive reads take the same gate.

**Read denied → 404, never 403.** A distinguishable 403 on
`/api/catalog/gem?key=@acme/secret-deploy` confirms the gem exists. Gem keys are
guessable (org name plus a plausible slug), so a 403 turns the private catalog into
an enumeration oracle over customers' internal tooling names. Every negative result
is `404`, identical to a key that was never published.

**Redeem invite.** `POST /api/catalog/groups/:id/invites` (admin) mints a raw token
and stores its sha256. Redeem requires a session and inserts a `source='invite'` row.
Expired or revoked → `410` with a real message; the token is high-entropy, so there
is no oracle to protect and a clear error is better.

**Missing session** on a credentialed route → `401`. The SPA redirects to login; the
CLI prints a `run agentgem bind` hint.

## Uninstalling the GitHub App

`deleteInstallation` (`githubApp.ts:33`) is documented as "uninstall = forget."
Under this design it deletes the federated group's `source='sync'` rows and nothing
else. The group survives, its invited guests survive, its `gem_shares` survive. Every
org member loses access the moment the sync rows go.

This required no special case: uninstall, member-removal, and suspension all reduce
to the same `WHERE source = 'sync'` clause.

## Why usage stays federated-only

`usage_days.scope` (`packages/aggregator/src/schema.ts:158`) is the lowercased
**GitHub repo owner**, derived from the local git remote on the reporting machine.
It answers "who owns the repo you were working in," not "which group are you in." A
native group has no repo owner, so there is no honest scope to attribute usage to.

`resolveOrgAccess`, `usage_days`, `org_settings`, and `/orgs/:scope/usage` are
untouched by this spec. This leaves org access with two answers for a while — the
old scope-based one for usage, the new membership-based one for gems. That is real
duplication and a future spec should collapse it. Attributing usage to groups is a
larger problem than this spec, and pretending otherwise would produce a dashboard
that lies.

## Testing

One test carries most of the weight, and it must be table-driven over the real
constant:

> Seed one private gem. Import `PUBLIC_READ_PATHS` from `src/originGuard.ts`, iterate
> every entry plus the registry routes, `GET` each with no credentials, and assert the
> gem's key, name, and bytes appear in none of them.

This fails the day someone adds a route to `PUBLIC_READ_PATHS` without a visibility
filter. Given that this repo has already shipped a `PUBLIC_READ_PATHS` bug that
silently broke `/minigames`, that is the failure mode with the best track record here.
It converts a policy into an enforced invariant.

Also:

- `canReadGem` across six cases: public; member of a shared group; invited guest;
  non-member; owner whose group was deleted; gem shared with zero groups.
- **Reconciler test:** an invited guest survives a sync that removes every synced
  member. This is the entire reason `source` exists and should break loudly if
  someone "simplifies" the delete predicate.
- 404-not-403 on a private key the caller cannot read.
- Publishing to a group you are not a member of is rejected.
- Invite redemption is multi-use, and stops at expiry and at revocation.

## Known traps in this repo

- `schema.test` has a hardcoded table list. Adding `groups`, `group_members`,
  `group_invites`, and `gem_shares` fails it until updated, and the failure looks
  unrelated to the change.
- `ensureSchema` does not backfill columns on existing tables:
  `CREATE TABLE IF NOT EXISTS` silently skips them. `catalog_gems.visibility` needs a
  paired `alter table ... add column if not exists`. This exact omission (commit
  `52e3d3c`) once put a 500 into production behind a "No profile" message.
- `packages/console` tests and typecheck are not in CI. Run them locally.

## Sequels

In the order they become worth doing:

1. `account_identities` split — one account, many ways to prove it. Cheap now (one
   provider, few rows), expensive later. Enables everything below.
2. Google OIDC signup, with a verified email as the account-linking key.
3. Slack as a second federated membership source, writing `source='sync'` rows into
   the same `group_members` table.
4. Re-key `published_by` onto `accounts.id`; fix `canReadGem`'s owner clause and
   `deleteCatalogGem` together.
5. Collapse `resolveOrgAccess` into group membership, once usage attribution has a
   group-shaped answer.
