# Group-shared gems — design

Date: 2026-07-11
Branch base: `origin/main` (`29ffe995`)
Status: approved design, pre-implementation

## Problem

`app.agentgem.ai` (the `@agentgem/marketplace` SPA) has no way for a user to create a
team/group, and the backend "native group" primitive — a fully-built membership lattice
(`groups`, `group_members`, `group_invites`, `POST /api/catalog/groups`) — is not reachable
from any UI. More importantly, a native group currently **grants access to nothing**: no code
reads group membership as an access or visibility gate (the only reader is
`accountLinking.ts`, a merge-blocker check). Creating a group today yields an empty container.

This design gives native groups a **payload**: an owner can share a private gem with a group,
and members of that group gain access to it. It also exposes the group-management surface
(create / list / invite / join) that was scoped but never built.

## Decisions (settled during brainstorming)

1. **Target = native invite-groups** (the built `/api/catalog/groups` endpoint), not the
   GitHub-synced `/orgs/:scope` dashboards. Native groups have `scope = null` and cannot reuse
   the org pages; they get their own address `/groups/:uuid`.
2. **Sharing model = additive ACL**, not a new visibility value. A gem stays
   `visibility = 'private'`; a new `gem_group_shares` table widens who may access it. The
   `public | unlisted | private` enum is untouched.
3. **v1 surfaces = access enforcement + owner share-management + "shared with me" discovery.**
   The group's detail page lists the apps shared with it, so a member can find shared gems
   without being handed a link.
4. **Shares key on `gem_key`, not `(gem_key, version)`** — you share "the app"; members can
   access its private versions. One row per share.
5. **Enforcement generalizes the existing owner-gated resolve endpoints** rather than making the
   anonymous public path session-aware (which would break its ETag/Cache-Control).

## Why this is the new capability

`unlisted` already covers "hand my team a link" (hidden from Explore, reachable by
`/games/<key>`), but anyone with the link gets in. Group-sharing adds **access control**: a gem
only *members* can resolve / install / open. So group-shared = "`private`, **plus** these
groups."

## A. Data model

Reused as-is (no schema change): `groups`, `group_members`, `group_invites`.

New table `gem_group_shares`:

| column        | type   | notes                                             |
|---------------|--------|---------------------------------------------------|
| `gem_key`     | text   | the app identity (not per-version)                |
| `group_id`    | uuid   | references `groups.id`; cascade on group delete   |
| `created_by`  | uuid   | account that created the share                    |
| `created_at_ms` | bigint | timestamp                                       |
| PK            |        | `(gem_key, group_id)`                             |

Added via a paired `create table if not exists` in the aggregator's `ensureSchema` path (the
repo's convention for additive schema; column/table drift is otherwise silent).

Cleanup:
- Group delete → shares cascade (FK).
- Gem unpublish/delete (`deleteCatalogGem`, `deleteGemArchiveOwned`) → delete that gem's shares.

## B. Access enforcement — the single gate

New helper in `packages/aggregator/src/catalog.ts`:

```
accountCanAccessGem(db, gemKey, version, accountId): boolean =
     visibility !== 'private'                               // public / unlisted: unchanged
  OR accountId != null && accountId === ownerAccountId      // owner
  OR accountId != null && EXISTS a gem_group_shares row for gemKey
       whose group_id ∈ (groups accountId is a member of)   // NEW: shared-group member
```

Backed by `gemAccessInfo(gemKey, version)` (already returns `{ visibility, ownerAccountId }`)
plus one membership-intersection query.

Integration: **generalize the existing owner-gated resolve handlers** in
`src/catalog/install.ts` — `ownerGameHtmlHandler`, `ownerGameMetaHandler`,
`ownerGemArchiveHandler`, `ownerGemHandler` — from the strict `info.ownerAccountId !== accountId`
check to `accountCanAccessGem(...)`. Owner is a subset, so this adds member access with almost
no new surface. The **anonymous** public path (AggregatorController, with its caching headers)
is left untouched. The no-leak `404` rule is preserved for anyone without access.

Owner-detail (`catalogGemForOwner`) needs a viewer variant (`catalogGemForViewer`) that returns
the row when `accountCanAccessGem` passes, rather than filtering strictly by owner.

## C. Backend API

### Groups management — already exists (no work)
`/api/catalog/groups` (GET my groups, POST create, DELETE), `/api/catalog/group-members`,
`/api/catalog/group-invites`, `/api/catalog/group-invite-redeem`. Session-gated; no-leak 404.

### Shares management — new, owner-gated
`/api/catalog/gem-shares`:
- `GET ?key=` → groups this gem is shared with (owner-only).
- `POST {key, groupId}` → share. Owner-gated **and** the owner must be a member of `groupId`
  (you can only share to groups you belong to). 403/404 otherwise.
- `DELETE ?key=&groupId=` → unshare (owner-only).

### Discovery — new, member-gated
`GET /api/catalog/group-gems?id=<groupId>` → gems shared with a group the caller is a member of.
Reuses the `requireGroupRole(deps, req, res, needAdmin=false)` member gate from
`src/groups/install.ts`.

## D. Frontend (`@agentgem/marketplace`)

### API clients
- New `src/groups.ts` — `makeGroups(base)`: `list`, `create(name)`, `remove(id)`,
  `members(id)`, `removeMember(id, account)`, `invites(id)`,
  `createInvite(id, {role, ttlDays})`, `revokeInvite(id, invite)`, `redeem(token)`. Mirrors
  `stars.ts`: credentialed fetch, `401 → NotSignedIn`.
- Share methods (in `groups.ts` or `api.ts`): `listGemShares(key)`, `shareGem(key, groupId)`,
  `unshareGem(key, groupId)`, `groupGems(groupId)`.

### Pages
- `pages/Groups.tsx` → `/groups` — gated on `me` (like `Publish`/`Account`); lists my groups;
  inline "New group" form; rows link to `/groups/:id`.
- `pages/GroupDetail.tsx` → `/groups/:id` — members list, mint/revoke invite links (token shown
  exactly once), remove member, delete group, **and "Apps shared with this group"** (the
  discovery listing, from `group-gems`).
- Join landing → `/groups/join?token=…` → `redeem`, then redirect into the group.
- `pages/Gem.tsx` (existing) — owner-only "Share with group" control: multi-select from my
  groups, toggling `shareGem` / `unshareGem`.

### Routing (`Router.tsx`)
Add: `groups` panel (`/groups`), `groups` collection (`/groups/:id`), join route. Add `"groups"`
to `COLLECTIONS` and `PANELS`. Satisfy `Router.conformance.test.tsx`.

### Entry point (`App.tsx`)
Signed-in "Groups" nav link in the header.

## E. Error handling & security invariants

- All group and share writes are session-gated (`401` when signed out).
- No-leak `404` for non-owner / non-member on every private-serving and group-scoped path — a
  stranger cannot distinguish "no access" from "does not exist".
- Sharing to a group you do not belong to is refused.
- Group delete cascades `gem_group_shares`; gem unpublish deletes the gem's shares.
- Invite raw token is returned exactly once (existing behavior), never stored or logged.
- `accountCanAccessGem` is the single choke point; every private-serving reader routes through
  it (extends the repo's "every `catalog_gems` reader must filter visibility" rule to "every
  private reader must also consult shares").

## F. Testing

- `accountCanAccessGem` truth table: public ✓ (any caller), unlisted ✓ (any caller), private →
  owner ✓, shared-group member ✓, stranger ✗, member-of-an-unshared-group ✗, signed-out ✗.
- `gem_group_shares` store: CRUD; cascade on group delete; cleanup on gem delete.
- Route gating: `gem-shares` owner-only (share/unshare/list); `group-gems` member-only; the
  generalized resolve endpoints serve owner + shared-member and no-leak-404 everyone else.
- Frontend: a `.test.tsx` per new page (repo convention — every page has a paired test); Router
  conformance test updated for the new routes/classifications; `groups.ts` client test.

## G. Rollout

Spec-sized but splits into ~2–3 PRs at the writing-plans stage:
1. Backend: `gem_group_shares` + `accountCanAccessGem` + generalized resolve endpoints +
   `gem-shares` endpoints + cascade/cleanup.
2. Backend/discovery: `group-gems` endpoint.
3. Frontend: `groups.ts` client, pages, routing, nav entry, `Gem.tsx` share control.

All work on this worktree (`group-shared-gems`, off `origin/main`). Each PR gated by CI
`test (24)`; verify each commit lands on `origin/main` after merge (per the repo's
dropped-commit trap).

## Out of scope (deferred)

- Federated groups (Plan 1b `groupsFederation.ts` — does not exist yet).
- Group-scoped usage dashboards / analytics.
- `?scope=<name>` human-readable group addressing (native groups stay UUID-addressed).
- Sharing anything other than gems (channels, workspaces) with groups.
