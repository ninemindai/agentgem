# Gem Review Staging — Design

**Date:** 2026-07-10
**Status:** Approved design, pre-implementation
**Feature line:** Team collaboration → **D (collaborative authoring)**, first slice

## Context

AgentGem already has a mature *distribution* and *org-structure* layer for teams:

- **Groups** — native + GitHub-org-federated, with a two-grant membership lattice
  (`via_sync` / `via_invite`) and `admin` / `member` roles (`groups.ts`, `groupMembers`).
- **Group invites** — revocable, multi-use share links (`groupInvites`).
- **Org catalog / scorecard** — every `@scope/*` gem with a maturity rubric
  (`orgCatalog.ts`, `orgRubric.ts`), plus Team Pulse usage dashboards.
- **Reviews + stars** on *published* gems, **share cards**, **`.gem` archives**
  (`gemArchives`, export/install).

What is missing is a **human authoring loop**: today publishing is solo. You build a
gem locally (console/Studio for miniapps, files for skills/subagents) and then
`Publish` / `Share link` pushes it straight out. There is no stage where a *draft*
exists that a teammate can inspect and bless before it goes live.

This design adds that stage — a **review-gated staging state** — and does so by
reusing the existing archive + catalog machinery rather than inventing new storage.

Team collaboration is being sequenced **D → A → B → (C via Slack)**:

- **D — collaborative authoring** (this spec): hand a draft gem to a teammate,
  review, approve → publish.
- **A — discuss gems**: threaded comments on *published* gems. This spec builds the
  comment primitive (`review_messages`) that A will later generalize.
- **B — stay aware**: activity feed + notifications. This spec emits status
  transitions as named events, which B (and Slack) subscribe to.
- **C — real-time messaging**: intentionally **not built** — delegated to Slack via
  the outbound-webhook seam introduced here.

## Goal / success criteria

An author in the console can submit a draft gem for review; a teammate in the same
group can install-and-test that draft locally, discuss it, and approve or request
changes; approval publishes the gem. All gated by group membership, with no
concurrent-editing or real-time infrastructure.

Concretely, the MVP is done when:

1. An author can hit **Request review** in the console and a staging gem + open
   review request is created, visible only to their group.
2. A *different* group member can see the request in a **Reviews inbox**, install the
   staging gem locally to test it, comment, and **Approve** / **Request changes**.
3. Approval publishes the gem (runs the real publish guards) and clears it from
   staging; the author is notified via an inbox badge.
4. Every transition guard in §"Edge cases" holds under the tests in §"Testing".

Explicitly **out of scope** for MVP: assigned/required reviewers, multi-author or
real-time co-editing, a web (marketplace SPA) review surface, and email/Slack push
(seam only).

## Section 1 — Staging lifecycle & data model

### Gem status

`catalogGems` gains a status: `staging` → `published`. A `staging` gem is:

- scoped to a single group (`group_id`),
- **excluded from every public / marketplace / org-catalog query**,
- visible only to members of that group.

`staging` is a *status on the existing table*, not a new storage system. The archive
upload path, the `@scope/*` keying, and the maturity rubric all run unchanged — the
gem is simply hidden until approval.

### New table — `review_requests`

| column               | meaning                                                   |
| -------------------- | --------------------------------------------------------- |
| `id`                 | public handle for the request                             |
| `group_id`           | which team is reviewing (FK → `groups`)                   |
| `gem_key`            | the staged gem's key (`@scope/name`)                      |
| `version`            | the staged version                                        |
| `archive_id`         | FK → `gemArchives` (the uploaded snapshot under review)   |
| `author_account_id`  | who submitted                                             |
| `status`             | `open` / `approved` / `changes-requested` / `withdrawn`   |
| `created_at`         |                                                           |
| `resolved_at`        | set when leaving `open` to a terminal state               |

### Lifecycle

```
author (console) ──Request review──► upload archive
                                     + insert catalogGems(status=staging, group_id)
                                     + review_requests(status=open)
                                            │
        teammate opens request ◄────────────┘
                                            │
   ┌── approve ──────────► run publish guards → gem status = published,
   │                        request = approved, author notified
   ├── request changes ──► request = changes-requested; author revises &
   │                        re-submits (reuses the SAME request row)
   └── withdraw (author) ─► staging gem + archive deleted;
                            request kept as `withdrawn` for history
```

### Reuse, not reinvent

The archive upload, `@scope/*` keying, and rubric already exist. Staging runs them
with the gem hidden. **Publishing to `@scope/*` still respects existing
scope-ownership guards** — a member cannot stage into a scope they do not own.

## Section 2 — Review conversation & UI surfaces

### Conversation — `review_messages`

The review request carries a comment thread.

| column              | meaning                          |
| ------------------- | -------------------------------- |
| `id`                |                                  |
| `request_id`        | FK → `review_requests`           |
| `author_account_id` | who wrote the message            |
| `body`              | comment text                     |
| `created_at`        |                                  |

This is the **same primitive feature A will later generalize** to published gems, so
building it here is a down-payment on A, not throwaway.

It is deliberately **separate from the existing `reviews` table**:

- `reviews` = star-ratings on *published* gems — a public trust signal.
- `review_messages` = private authoring discussion on a *staging* gem — different
  lifecycle, different audience.

Overloading one table with both meanings is exactly the kind of ambiguity to avoid.

### Where each side works — both in the console

The value of review is *evaluating the real thing*, and only the **console** can
install-and-run a gem locally. The marketplace SPA is a read/discover surface. So
MVP review is console-only.

- **Author (console → Studio / publish flow):** the existing publish button gains a
  sibling **"Request review"**. After submitting, a status chip shows `In review` /
  `Changes requested`, and they respond to comments inline.
- **Reviewer (console → new "Reviews" inbox):** a list of open requests across their
  groups. Opening one lets them **install the staging gem locally to actually test
  it**, read the description + rubric, comment, and **Approve** / **Request changes**.

**Why not the marketplace SPA for MVP:** a web-only review could not install/run the
gem — the weakest form of review. A web "approve from your phone" view is a genuine
follow-on, not MVP.

## Section 3 — Notifications

### MVP: the inbox *is* the notification. No new infra.

The console already polls the aggregator for warm feeds; the Reviews inbox rides on
that same poll.

- **Reviewer side:** a badge count on the "Reviews" nav item = open requests across
  your groups where you have not responded.
- **Author side:** a badge on requests with activity since you last looked (new
  comment, or a `changes-requested` / `approved` transition).

"Since you last looked" needs one cheap piece of state — a `review_seen` marker keyed
on `(account_id, request_id)` storing `last_seen_at`. That is the entire
read-tracking model.

### Deliberately not in MVP (seam left clean)

- **Email / Slack push.** C lives in Slack, so the right home for "ping me when a
  review lands" is an **outbound webhook** the aggregator fires on request
  transitions (`open`, `approved`, `changes-requested`). A group admin pastes a Slack
  Incoming Webhook URL into `org_settings`; the aggregator POSTs a formatted message.

The one durable decision made now: **emit status changes as named events in a single
place**, so the webhook is a ~30-line subscriber later rather than a refactor.
Real-time notifications (websockets/push) are out — polling a badge count is
sufficient for an async review flow.

## Section 4 — Edge cases & testing

### Transition guards (all enforced server-side in the aggregator)

- **Self-approval blocked.** The author is a group member, so "any member approves"
  must still exclude the author: approver `account_id` ≠ `author_account_id`.
- **Atomic transitions.** Approve / withdraw / request-changes are conditional
  updates (`WHERE status = 'open'`). Two simultaneous approvals, or approve-racing
  -withdraw, cannot double-publish; the loser is a no-op.
- **Scope re-check *at approval*, not just at submit.** Approval is the real publish,
  and scope-ownership can change between staging and approval, so the `@scope/*`
  ownership guard runs **again** on approve. (Guards against the delete-guard ≠
  publish-guard class of bug that has bitten this repo before.)
- **Version collision.** Cannot stage a version that is already published — rejected
  at submit time.
- **Re-submission reuses the request.** After `changes-requested`, the author revises
  and re-uploads → same `review_requests` row, new `archive_id`, status back to
  `open`, `review_seen` markers cleared. The conversation thread stays intact.

### Lifecycle cleanup

- **Author leaves the group** (their `groupMembers` row deleted via the lattice) →
  their `open` requests auto-withdraw and the staging gems are purged. No orphaned
  staging gems visible to a team the author is no longer on.
- **Withdraw** deletes the staging `catalogGems` row + archive; the `review_requests`
  row is kept as `withdrawn` for history.

### Testing

- **Aggregator (Vitest):** the state machine gets the bulk — every transition, the
  atomic-guard races, self-approval block, scope re-check at approval,
  membership-removal cleanup, re-submission threading, version-collision reject.
  These are DB-state tests, the strongest ROI.
- **Console (Vitest):** Request-review button wiring, inbox badge counts,
  install-a-staging-gem-to-test.

### ⚠️ CI caveat

CI only gates the root `dist/__tests__`. **`packages/aggregator/src/__tests__` and
console tests do NOT run in CI.** The implementation plan must consciously choose one
of: (a) run these locally as a release gate, or (b) wire them into CI. This is called
out here so it is a decision, not a silent gap.

## Data-model summary (new)

| object            | kind        | note                                             |
| ----------------- | ----------- | ------------------------------------------------ |
| `catalogGems.status` | new column | `staging` \| `published`; + `group_id` for staging |
| `review_requests` | new table   | the request state machine                        |
| `review_messages` | new table   | conversation thread (seeds feature A)            |
| `review_seen`     | new table   | `(account_id, request_id)` → `last_seen_at`      |

Each new column on an existing aggregator table needs a paired
`alter table ... add column if not exists` (ensureSchema convention).

## Follow-ons (explicitly deferred)

1. Assigned / required reviewers (extend `review_requests` with a reviewer set).
2. Marketplace SPA read-only review surface ("approve from the web").
3. Slack / email push via the outbound-webhook seam + `org_settings`.
4. Feature A: generalize `review_messages` to threaded comments on published gems.
5. Feature B: activity feed subscribing to the emitted transition events.
