# Gem Review Staging — Backend Core Implementation Plan (Plan 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the server-side review-staging state machine (store functions + signed HTTP routes) so a group member can submit a gem draft for review, discuss it, and approve it into a real published gem — fully testable via Vitest with no UI.

**Architecture:** `packages/aggregator` is a pure Drizzle data-layer library; a new module `reviewStaging.ts` holds the state machine. HTTP routes are AgentBack `@post` methods added to the repo-root `src/aggregator.controller.ts`, authenticated by the existing signed-write path (`resolveSignedAccount`). Staging bytes + manifest live on the `review_requests` row (isolated from every published surface); on approval the request publishes through the normal `upsertCatalogGem` / `upsertGemArchive` functions.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Drizzle ORM (pg-core), PGlite (in-memory test DB), Vitest v4, AgentBack (`@agentback/openapi`) controllers, Zod bodies, ed25519 signatures (`@agentgem/model`).

**Scope:** This is **Plan 1 of 2**. It delivers the entire backend and is testable/valuable on its own. **Plan 2** (console: local signing routes + Studio "Request review" button + Reviews inbox panel) is written separately and depends on the routes this plan produces.

## Global Constraints

- Node floor: `>=24`. ESM only; every relative import uses a `.js` specifier even for `.ts` files.
- New store functions MUST be re-exported from `packages/aggregator/src/index.ts` or tests importing from `@agentgem/aggregator` fail to resolve.
- Store tests live at repo root under `src/aggregator/__tests__/*.test.ts` and import from `@agentgem/aggregator` (NOT via relative package paths).
- DB access is Drizzle only; new DDL goes in `ensureSchema` (schema.ts) as idempotent `create table if not exists` + paired `alter table ... add column if not exists` (the repo's ensureSchema convention — there is no drizzle-kit migration step).
- Ownership/authorization is ALWAYS the `accounts.id` uuid, NEVER a `login`/`published_by` string (no uniqueness guarantee). A NULL owner is owned by nobody (fail closed). This mirrors `deleteCatalogGem` / `recordCatalogShare`.
- Timestamps on the new tables are `bigint` epoch-ms columns (matching `catalog_gems.created_at_ms` / `gem_archives.created_at_ms`), and every store function takes an optional trailing `now: number = Date.now()` param for deterministic tests.
- Full local test run: `pnpm test` (root, = `tsc -b && vitest run`). Single file: `npx vitest run src/aggregator/__tests__/reviewStaging.test.ts`.
- ⚠️ **CI does not run these tests.** Root `test (24)` gates only `dist/__tests__`; the aggregator store tests under `src/aggregator/__tests__` and controller tests are NOT in CI (documented repo gap). Run them locally as the gate for every task, and note this in the final PR body.

---

## File Structure

- **Create** `packages/aggregator/src/reviewStaging.ts` — the state machine: submit / list-inbox / get / archive / message / approve / request-changes / resubmit / withdraw / mark-seen / cleanup. One responsibility: the review-request lifecycle.
- **Modify** `packages/aggregator/src/schema.ts` — three new `pgTable` defs (`reviewRequests`, `reviewMessages`, `reviewSeen`), add them to the exported `schema` object, and add their DDL to `ensureSchema`.
- **Modify** `packages/aggregator/src/index.ts` — re-export everything from `reviewStaging.ts`.
- **Modify** `packages/aggregator/src/groups.ts` — `removeMemberGuarded` calls the new `withdrawRequestsForDepartedMember` cleanup.
- **Modify** `src/aggregator.controller.ts` — new Zod schemas + `@post` route methods under `/api/aggregator/review/*`, plus canonical signing-payload helpers.
- **Create** `src/aggregator/__tests__/reviewStaging.test.ts` — store-level state-machine tests (makeTestDb + upsertAccount).
- **Create** `src/aggregator/__tests__/reviewStagingController.test.ts` — controller/HTTP-level tests (signed requests against `new AggregatorController(db)`).

---

## Task 1: Schema — three staging tables + DDL

**Files:**
- Modify: `packages/aggregator/src/schema.ts`
- Modify: `packages/aggregator/src/index.ts`
- Test: `src/aggregator/__tests__/reviewStaging.test.ts`

**Interfaces:**
- Consumes: existing `bytea` customType (schema.ts:281), `groups`, `accounts` tables.
- Produces: exported `reviewRequests`, `reviewMessages`, `reviewSeen` pgTable objects; `ReviewStatus` type. `ensureSchema` creates all three tables.

- [ ] **Step 1: Write the failing test**

Create `src/aggregator/__tests__/reviewStaging.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { makeTestDb, reviewRequests } from "@agentgem/aggregator";

describe("review staging schema", () => {
  it("ensureSchema creates review_requests and the table accepts a row", async () => {
    const db = await makeTestDb(); // makeTestDb runs ensureSchema
    const rows = await db.select().from(reviewRequests);
    expect(rows).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/aggregator/__tests__/reviewStaging.test.ts`
Expected: FAIL — `reviewRequests` is not exported from `@agentgem/aggregator`.

- [ ] **Step 3: Add the three pgTable defs to schema.ts**

In `packages/aggregator/src/schema.ts`, after the `gemArchives` table (line ~294), add (the `bytea` customType is already defined just above `gemArchives`):

```ts
export type ReviewStatus = "open" | "approved" | "changes-requested" | "withdrawn";

// A staging gem under review. Bytes + manifest live HERE, isolated from every published surface
// (catalog_gems / gem_archives), until approval publishes through the normal upsert functions.
// Ownership/authorship is the accounts.id uuid, never a login string. Timestamps are epoch-ms
// bigints (matching the gem tables) so store fns take an explicit `now` and tests stay deterministic.
export const reviewRequests = pgTable("review_requests", {
  id: uuid("id").primaryKey(),
  groupId: uuid("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
  gemKey: text("gem_key").notNull(),
  version: text("version").notNull(),
  authorAccountId: uuid("author_account_id").notNull().references(() => accounts.id),
  status: text("status").$type<ReviewStatus>().notNull().default("open"),
  description: text("description"),
  manifest: jsonb("manifest").notNull(),          // the CatalogManifest to publish on approval
  archiveBytes: bytea("archive_bytes"),           // .gem bytes; nulled on approve/withdraw
  archiveDigest: text("archive_digest").notNull(),
  createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
  resolvedAtMs: bigint("resolved_at_ms", { mode: "number" }),
}, (t) => [index("review_requests_group_idx").on(t.groupId)]);

export const reviewMessages = pgTable("review_messages", {
  id: uuid("id").primaryKey(),
  requestId: uuid("request_id").notNull().references(() => reviewRequests.id, { onDelete: "cascade" }),
  authorAccountId: uuid("author_account_id").notNull().references(() => accounts.id),
  body: text("body").notNull(),
  createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
}, (t) => [index("review_messages_request_idx").on(t.requestId)]);

// Read-tracking marker: when this account last opened this request. Drives the inbox unread badge.
export const reviewSeen = pgTable("review_seen", {
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  requestId: uuid("request_id").notNull().references(() => reviewRequests.id, { onDelete: "cascade" }),
  lastSeenAtMs: bigint("last_seen_at_ms", { mode: "number" }).notNull(),
}, (t) => [primaryKey({ columns: [t.accountId, t.requestId] })]);
```

Add the three tables to the `schema` object (schema.ts:396):

```ts
export const schema = { producers, attestations, ingredients, usageEdges, modelOutcomes, accountBindings, shareCards, apiKeys, accounts, handoffCodes, stars, reviews, gemAdoptions, accountScopes, usageDays, usageDayModels, orgSettings, catalogGems, gemArchives, gamePlays, curatedSkills, appInstallations, orgMembers, groups, groupMembers, groupInvites, reviewRequests, reviewMessages, reviewSeen, user, session, account, verification };
```

- [ ] **Step 4: Add DDL to ensureSchema**

In `ensureSchema` (schema.ts), immediately before the `backfillBindingAnchors(db)` call (line ~666), add:

```ts
  await db.execute(sql`create table if not exists review_requests (
    id uuid primary key,
    group_id uuid not null references groups(id) on delete cascade,
    gem_key text not null,
    version text not null,
    author_account_id uuid not null references accounts(id),
    status text not null default 'open' check (status in ('open','approved','changes-requested','withdrawn')),
    description text,
    manifest jsonb not null,
    archive_bytes bytea,
    archive_digest text not null,
    created_at_ms bigint not null,
    resolved_at_ms bigint
  )`);
  await db.execute(sql`create index if not exists review_requests_group_idx on review_requests (group_id)`);
  await db.execute(sql`create table if not exists review_messages (
    id uuid primary key,
    request_id uuid not null references review_requests(id) on delete cascade,
    author_account_id uuid not null references accounts(id),
    body text not null,
    created_at_ms bigint not null
  )`);
  await db.execute(sql`create index if not exists review_messages_request_idx on review_messages (request_id)`);
  await db.execute(sql`create table if not exists review_seen (
    account_id uuid not null references accounts(id),
    request_id uuid not null references review_requests(id) on delete cascade,
    last_seen_at_ms bigint not null,
    primary key (account_id, request_id)
  )`);
```

- [ ] **Step 5: Re-export from index.ts**

In `packages/aggregator/src/index.ts`, add alongside the other schema/module re-exports:

```ts
export * from "./reviewStaging.js";
```

Confirm the schema tables are already reachable via the existing `export * from "./schema.js";` (they are — Step 3 exported them). If `index.ts` re-exports specific names rather than `*`, add `reviewRequests, reviewMessages, reviewSeen, type ReviewStatus` to the schema re-export list.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/aggregator/__tests__/reviewStaging.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/aggregator/src/schema.ts packages/aggregator/src/index.ts src/aggregator/__tests__/reviewStaging.test.ts
git commit -m "feat(aggregator): review-staging tables (review_requests/messages/seen)"
```

---

## Task 2: `submitReviewRequest` — create a staging request (with guards)

**Files:**
- Create: `packages/aggregator/src/reviewStaging.ts`
- Modify: `packages/aggregator/src/index.ts` (already re-exports `./reviewStaging.js` from Task 1)
- Test: `src/aggregator/__tests__/reviewStaging.test.ts`

**Interfaces:**
- Consumes: `groupMemberRole(db, groupId, accountId)` (groups.ts), `catalogGemExists(db, gemKey, version)` (catalog.ts), `type CatalogManifest` (catalog.ts).
- Produces:
  ```ts
  export type SubmitResult =
    | { ok: true; requestId: string }
    | { ok: false; rejected: "not-a-member" | "version-published" | "invalid-key" };
  export async function submitReviewRequest(
    db: AppDb,
    args: { accountId: string; groupId: string; manifest: CatalogManifest; archiveBytes: Uint8Array; archiveDigest: string; description?: string },
    now?: number,
  ): Promise<SubmitResult>;
  ```

- [ ] **Step 1: Write the failing test**

Append to `src/aggregator/__tests__/reviewStaging.test.ts`:

```ts
import { makeTestDb, upsertAccount, createNativeGroup, grantInvite, submitReviewRequest, upsertCatalogGem } from "@agentgem/aggregator";

const mkManifest = (gemKey: string, version = "1.0.0") => ({ gemKey, version, description: "d", gemDigest: "sha256:deadbeef" });

describe("submitReviewRequest", () => {
  it("a group member can submit a staging request", async () => {
    const db = await makeTestDb();
    const author = await upsertAccount(db, { provider: "github", accountId: "a1", login: "alice" });
    const g = await createNativeGroup(db, author.id, "Team");
    const r = await submitReviewRequest(db, {
      accountId: author.id, groupId: g.id, manifest: mkManifest("@team/bot"),
      archiveBytes: new Uint8Array([1, 2, 3]), archiveDigest: "sha256:deadbeef", description: "please review",
    });
    expect(r.ok).toBe(true);
  });

  it("rejects a non-member", async () => {
    const db = await makeTestDb();
    const owner = await upsertAccount(db, { provider: "github", accountId: "o", login: "owner" });
    const outsider = await upsertAccount(db, { provider: "github", accountId: "x", login: "mallory" });
    const g = await createNativeGroup(db, owner.id, "Team");
    const r = await submitReviewRequest(db, {
      accountId: outsider.id, groupId: g.id, manifest: mkManifest("@team/bot"),
      archiveBytes: new Uint8Array([1]), archiveDigest: "sha256:x",
    });
    expect(r).toEqual({ ok: false, rejected: "not-a-member" });
  });

  it("rejects a version that is already published", async () => {
    const db = await makeTestDb();
    const author = await upsertAccount(db, { provider: "github", accountId: "a1", login: "alice" });
    const g = await createNativeGroup(db, author.id, "Team");
    await upsertCatalogGem(db, { gemKey: "@team/bot", version: "1.0.0", publishedBy: "alice", createdAtMs: 1, ownerAccountId: author.id });
    const r = await submitReviewRequest(db, {
      accountId: author.id, groupId: g.id, manifest: mkManifest("@team/bot", "1.0.0"),
      archiveBytes: new Uint8Array([1]), archiveDigest: "sha256:x",
    });
    expect(r).toEqual({ ok: false, rejected: "version-published" });
  });

  it("rejects a slash-less (unlisted-share) key", async () => {
    const db = await makeTestDb();
    const author = await upsertAccount(db, { provider: "github", accountId: "a1", login: "alice" });
    const g = await createNativeGroup(db, author.id, "Team");
    const r = await submitReviewRequest(db, {
      accountId: author.id, groupId: g.id, manifest: mkManifest("abc123", "1.0.0"),
      archiveBytes: new Uint8Array([1]), archiveDigest: "sha256:x",
    });
    expect(r).toEqual({ ok: false, rejected: "invalid-key" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/aggregator/__tests__/reviewStaging.test.ts -t submitReviewRequest`
Expected: FAIL — `submitReviewRequest` not exported.

- [ ] **Step 3: Create reviewStaging.ts with submitReviewRequest**

Create `packages/aggregator/src/reviewStaging.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Gem review staging: the state machine for "submit a draft gem to a group, discuss, approve -> publish".
//
//   submit ──► open ──approve──► (publishes) approved
//                │ └─request-changes─► changes-requested ──resubmit──► open
//                └─withdraw─► withdrawn (bytes cleared; row kept for history)
//
// Staging bytes + manifest live on the review_requests row, NOT in catalog_gems/gem_archives, so a
// staging gem can never leak into any published/marketplace/org-catalog read. Approval is the only
// path that writes the published tables, and it re-applies the catalog owner-conflict guard.
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { AppDb } from "./schema.js";
import { reviewRequests } from "./schema.js";
import { groupMemberRole } from "./groups.js";
import { catalogGemExists, type CatalogManifest } from "./catalog.js";

export type SubmitResult =
  | { ok: true; requestId: string }
  | { ok: false; rejected: "not-a-member" | "version-published" | "invalid-key" };

export async function submitReviewRequest(
  db: AppDb,
  args: { accountId: string; groupId: string; manifest: CatalogManifest; archiveBytes: Uint8Array; archiveDigest: string; description?: string },
  now: number = Date.now(),
): Promise<SubmitResult> {
  // Same key rule as recordCatalogShare: a published key is scope/name and ALWAYS contains "/".
  if (!args.manifest.gemKey.includes("/")) return { ok: false, rejected: "invalid-key" };
  if ((await groupMemberRole(db, args.groupId, args.accountId)) === null) return { ok: false, rejected: "not-a-member" };
  if (await catalogGemExists(db, args.manifest.gemKey, args.manifest.version)) return { ok: false, rejected: "version-published" };
  const id = randomUUID();
  await db.insert(reviewRequests).values({
    id, groupId: args.groupId, gemKey: args.manifest.gemKey, version: args.manifest.version,
    authorAccountId: args.accountId, status: "open", description: args.description ?? null,
    manifest: args.manifest as unknown as Record<string, unknown>,
    archiveBytes: args.archiveBytes, archiveDigest: args.archiveDigest, createdAtMs: now, resolvedAtMs: null,
  });
  return { ok: true, requestId: id };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/aggregator/__tests__/reviewStaging.test.ts -t submitReviewRequest`
Expected: PASS (all 4 cases).

- [ ] **Step 5: Commit**

```bash
git add packages/aggregator/src/reviewStaging.ts src/aggregator/__tests__/reviewStaging.test.ts
git commit -m "feat(aggregator): submitReviewRequest with member/version/key guards"
```

---

## Task 3: Inbox listing + read-tracking (`listInbox`, `markSeen`)

**Files:**
- Modify: `packages/aggregator/src/reviewStaging.ts`
- Test: `src/aggregator/__tests__/reviewStaging.test.ts`

**Interfaces:**
- Consumes: `listGroupsForAccount(db, accountId)` (groups.ts), `accounts` table (for author login).
- Produces:
  ```ts
  export interface ReviewRequestSummary {
    id: string; groupId: string; groupName: string; gemKey: string; version: string;
    authorAccountId: string; authorLogin: string | null; status: ReviewStatus;
    description: string | null; createdAtMs: number; resolvedAtMs: number | null;
    messageCount: number; unread: boolean;
  }
  export async function listInbox(db: AppDb, accountId: string): Promise<ReviewRequestSummary[]>;
  export async function markSeen(db: AppDb, accountId: string, requestId: string, now?: number): Promise<void>;
  ```
- `unread` = there is activity (a message OR the request itself) newer than this account's `review_seen.last_seen_at_ms` for the request (missing marker ⇒ unread).

- [ ] **Step 1: Write the failing test**

Append to the test file:

```ts
import { listInbox, markSeen } from "@agentgem/aggregator";

describe("listInbox + markSeen", () => {
  it("lists open requests for the viewer's groups, newest first, unread until seen", async () => {
    const db = await makeTestDb();
    const author = await upsertAccount(db, { provider: "github", accountId: "a1", login: "alice" });
    const reviewer = await upsertAccount(db, { provider: "github", accountId: "r1", login: "rob" });
    const g = await createNativeGroup(db, author.id, "Team");
    await grantInvite(db, g.id, reviewer.id, "member");
    const r = await submitReviewRequest(db, {
      accountId: author.id, groupId: g.id, manifest: mkManifest("@team/bot"),
      archiveBytes: new Uint8Array([1]), archiveDigest: "sha256:x", description: "d",
    }, 1000);
    if (!r.ok) throw new Error("submit failed");

    const before = await listInbox(db, reviewer.id);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ id: r.requestId, gemKey: "@team/bot", authorLogin: "alice", status: "open", unread: true });

    await markSeen(db, reviewer.id, r.requestId, 2000);
    const after = await listInbox(db, reviewer.id);
    expect(after[0].unread).toBe(false);
  });

  it("does not list requests from groups the viewer is not in", async () => {
    const db = await makeTestDb();
    const author = await upsertAccount(db, { provider: "github", accountId: "a1", login: "alice" });
    const outsider = await upsertAccount(db, { provider: "github", accountId: "x", login: "mallory" });
    const g = await createNativeGroup(db, author.id, "Team");
    await submitReviewRequest(db, { accountId: author.id, groupId: g.id, manifest: mkManifest("@team/bot"), archiveBytes: new Uint8Array([1]), archiveDigest: "sha256:x" }, 1000);
    expect(await listInbox(db, outsider.id)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/aggregator/__tests__/reviewStaging.test.ts -t listInbox`
Expected: FAIL — `listInbox` not exported.

- [ ] **Step 3: Implement listInbox + markSeen**

Add to `reviewStaging.ts` (add `reviewMessages`, `reviewSeen`, `accounts` to the schema import, `type ReviewStatus`, and `listGroupsForAccount` to the groups import):

```ts
import { reviewRequests, reviewMessages, reviewSeen, accounts, type ReviewStatus } from "./schema.js";
import { groupMemberRole, listGroupsForAccount } from "./groups.js";

export interface ReviewRequestSummary {
  id: string; groupId: string; groupName: string; gemKey: string; version: string;
  authorAccountId: string; authorLogin: string | null; status: ReviewStatus;
  description: string | null; createdAtMs: number; resolvedAtMs: number | null;
  messageCount: number; unread: boolean;
}

export async function listInbox(db: AppDb, accountId: string): Promise<ReviewRequestSummary[]> {
  const groups = await listGroupsForAccount(db, accountId);
  if (groups.length === 0) return [];
  const groupIds = groups.map((g) => g.id);
  const nameById = new Map(groups.map((g) => [g.id, g.name]));
  const rows = await db.execute(sql`
    select r.id, r.group_id, r.gem_key, r.version, r.author_account_id, r.status, r.description,
           r.created_at_ms, r.resolved_at_ms, a.login as author_login,
           (select count(*)::int from review_messages m where m.request_id = r.id) as message_count,
           coalesce(greatest(r.created_at_ms, (select max(m.created_at_ms) from review_messages m where m.request_id = r.id)), r.created_at_ms) as last_activity_ms,
           (select s.last_seen_at_ms from review_seen s where s.request_id = r.id and s.account_id = ${accountId}) as last_seen_ms
    from review_requests r
    join accounts a on a.id = r.author_account_id
    where r.group_id in (${sql.join(groupIds.map((g) => sql`${g}`), sql`, `)})
      and r.status in ('open','changes-requested')
    order by last_activity_ms desc`);
  return (rows.rows as any[]).map((r) => ({
    id: r.id, groupId: r.group_id, groupName: nameById.get(r.group_id) ?? "", gemKey: r.gem_key, version: r.version,
    authorAccountId: r.author_account_id, authorLogin: r.author_login ?? null, status: r.status as ReviewStatus,
    description: r.description ?? null, createdAtMs: Number(r.created_at_ms), resolvedAtMs: r.resolved_at_ms == null ? null : Number(r.resolved_at_ms),
    messageCount: Number(r.message_count),
    unread: r.last_seen_ms == null || Number(r.last_seen_ms) < Number(r.last_activity_ms),
  }));
}

export async function markSeen(db: AppDb, accountId: string, requestId: string, now: number = Date.now()): Promise<void> {
  await db.insert(reviewSeen).values({ accountId, requestId, lastSeenAtMs: now })
    .onConflictDoUpdate({ target: [reviewSeen.accountId, reviewSeen.requestId], set: { lastSeenAtMs: now } });
}
```

Note: the inbox lists `open` and `changes-requested` (both are "needs someone's attention"); `approved`/`withdrawn` are terminal and drop off. Author sees their own `changes-requested` rows here too (they are a member of the group).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/aggregator/__tests__/reviewStaging.test.ts -t listInbox`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/aggregator/src/reviewStaging.ts src/aggregator/__tests__/reviewStaging.test.ts
git commit -m "feat(aggregator): review inbox listing + seen markers"
```

---

## Task 4: Request detail, messages, archive fetch (membership-gated reads)

**Files:**
- Modify: `packages/aggregator/src/reviewStaging.ts`
- Test: `src/aggregator/__tests__/reviewStaging.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ReviewMessageRow { id: string; authorAccountId: string; authorLogin: string | null; body: string; createdAtMs: number }
  export interface ReviewRequestDetail extends ReviewRequestSummary { manifest: CatalogManifest; archiveDigest: string; messages: ReviewMessageRow[] }
  export async function getReviewRequest(db: AppDb, accountId: string, requestId: string): Promise<ReviewRequestDetail | null>; // null = not found OR viewer not a member of its group
  export async function getReviewArchive(db: AppDb, accountId: string, requestId: string): Promise<{ bytes: Uint8Array; digest: string } | null>;
  export type MessageResult = { ok: true; messageId: string } | { ok: false; rejected: "not-found" | "not-a-member" };
  export async function addReviewMessage(db: AppDb, args: { accountId: string; requestId: string; body: string }, now?: number): Promise<MessageResult>;
  ```
- All three gate on `groupMemberRole(db, request.groupId, accountId) !== null`; a non-member gets `null` / `not-found` (membership and existence collapsed — no enumeration oracle).

- [ ] **Step 1: Write the failing test**

Append:

```ts
import { getReviewRequest, getReviewArchive, addReviewMessage } from "@agentgem/aggregator";

describe("request detail / messages / archive", () => {
  async function seed() {
    const db = await makeTestDb();
    const author = await upsertAccount(db, { provider: "github", accountId: "a1", login: "alice" });
    const reviewer = await upsertAccount(db, { provider: "github", accountId: "r1", login: "rob" });
    const outsider = await upsertAccount(db, { provider: "github", accountId: "x", login: "mallory" });
    const g = await createNativeGroup(db, author.id, "Team");
    await grantInvite(db, g.id, reviewer.id, "member");
    const r = await submitReviewRequest(db, { accountId: author.id, groupId: g.id, manifest: mkManifest("@team/bot"), archiveBytes: new Uint8Array([9, 9]), archiveDigest: "sha256:x", description: "d" }, 1000);
    if (!r.ok) throw new Error("submit failed");
    return { db, author, reviewer, outsider, g, requestId: r.requestId };
  }

  it("a member reads detail + archive; posts a message that appears in detail", async () => {
    const { db, reviewer, requestId } = await seed();
    const detail = await getReviewRequest(db, reviewer.id, requestId);
    expect(detail?.gemKey).toBe("@team/bot");
    expect(detail?.messages).toEqual([]);
    const arch = await getReviewArchive(db, reviewer.id, requestId);
    expect(Array.from(arch!.bytes)).toEqual([9, 9]);
    const m = await addReviewMessage(db, { accountId: reviewer.id, requestId, body: "looks good" }, 1500);
    expect(m.ok).toBe(true);
    const after = await getReviewRequest(db, reviewer.id, requestId);
    expect(after?.messages).toHaveLength(1);
    expect(after?.messages[0]).toMatchObject({ authorLogin: "rob", body: "looks good" });
  });

  it("a non-member gets null / not-found for detail, archive, and message", async () => {
    const { db, outsider, requestId } = await seed();
    expect(await getReviewRequest(db, outsider.id, requestId)).toBeNull();
    expect(await getReviewArchive(db, outsider.id, requestId)).toBeNull();
    expect(await addReviewMessage(db, { accountId: outsider.id, requestId, body: "x" })).toEqual({ ok: false, rejected: "not-a-member" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/aggregator/__tests__/reviewStaging.test.ts -t "request detail"`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement the three functions**

Add to `reviewStaging.ts`:

```ts
export interface ReviewMessageRow { id: string; authorAccountId: string; authorLogin: string | null; body: string; createdAtMs: number }
export interface ReviewRequestDetail extends ReviewRequestSummary { manifest: CatalogManifest; archiveDigest: string; messages: ReviewMessageRow[] }
export type MessageResult = { ok: true; messageId: string } | { ok: false; rejected: "not-found" | "not-a-member" };

/** Load the request row and confirm the viewer is a member of its group. Returns the row + role, or a
 *  reason. Shared by every membership-gated read/write below. */
async function loadForMember(db: AppDb, accountId: string, requestId: string) {
  const row = (await db.select().from(reviewRequests).where(eq(reviewRequests.id, requestId)).limit(1))[0];
  if (!row) return { kind: "not-found" as const };
  if ((await groupMemberRole(db, row.groupId, accountId)) === null) return { kind: "not-a-member" as const };
  return { kind: "ok" as const, row };
}

export async function getReviewRequest(db: AppDb, accountId: string, requestId: string): Promise<ReviewRequestDetail | null> {
  const r = await loadForMember(db, accountId, requestId);
  if (r.kind !== "ok") return null; // not-found and not-a-member collapse to null (no enumeration oracle)
  const row = r.row;
  const author = (await db.select({ login: accounts.login }).from(accounts).where(eq(accounts.id, row.authorAccountId)).limit(1))[0];
  const groupName = (await db.select({ name: sql<string>`name` }).from(reviewRequests).where(sql`false`)); // placeholder removed below
  const msgs = await db.execute(sql`
    select m.id, m.author_account_id, m.body, m.created_at_ms, a.login as author_login
    from review_messages m join accounts a on a.id = m.author_account_id
    where m.request_id = ${requestId} order by m.created_at_ms asc`);
  return {
    id: row.id, groupId: row.groupId, groupName: "", gemKey: row.gemKey, version: row.version,
    authorAccountId: row.authorAccountId, authorLogin: author?.login ?? null, status: row.status,
    description: row.description ?? null, createdAtMs: Number(row.createdAtMs),
    resolvedAtMs: row.resolvedAtMs == null ? null : Number(row.resolvedAtMs),
    messageCount: (msgs.rows as any[]).length, unread: false,
    manifest: row.manifest as unknown as CatalogManifest, archiveDigest: row.archiveDigest,
    messages: (msgs.rows as any[]).map((m) => ({ id: m.id, authorAccountId: m.author_account_id, authorLogin: m.author_login ?? null, body: m.body, createdAtMs: Number(m.created_at_ms) })),
  };
}

export async function getReviewArchive(db: AppDb, accountId: string, requestId: string): Promise<{ bytes: Uint8Array; digest: string } | null> {
  const r = await loadForMember(db, accountId, requestId);
  if (r.kind !== "ok" || r.row.archiveBytes == null) return null;
  return { bytes: r.row.archiveBytes, digest: r.row.archiveDigest };
}

export async function addReviewMessage(db: AppDb, args: { accountId: string; requestId: string; body: string }, now: number = Date.now()): Promise<MessageResult> {
  const r = await loadForMember(db, args.accountId, args.requestId);
  if (r.kind === "not-found") return { ok: false, rejected: "not-found" };
  if (r.kind === "not-a-member") return { ok: false, rejected: "not-a-member" };
  const id = randomUUID();
  await db.insert(reviewMessages).values({ id, requestId: args.requestId, authorAccountId: args.accountId, body: args.body, createdAtMs: now });
  return { ok: true, messageId: id };
}
```

Then delete the dead `groupName` placeholder line (`const groupName = ...`) — `getReviewRequest` returns `groupName: ""`; the inbox is where `groupName` is populated (Task 3). Keeping detail's `groupName` empty is intentional: the detail view already knows its group from context.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/aggregator/__tests__/reviewStaging.test.ts -t "request detail"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/aggregator/src/reviewStaging.ts src/aggregator/__tests__/reviewStaging.test.ts
git commit -m "feat(aggregator): review detail/messages/archive (membership-gated)"
```

---

## Task 5: `approveReviewRequest` — the crux (atomic, self-approval blocked, publishes)

**Files:**
- Modify: `packages/aggregator/src/reviewStaging.ts`
- Test: `src/aggregator/__tests__/reviewStaging.test.ts`

**Interfaces:**
- Consumes: `upsertCatalogGem`, `upsertGemArchive` (catalog.ts), `catalogGems` (schema, for the owner-conflict re-check).
- Produces:
  ```ts
  export type ApproveResult =
    | { ok: true; gemKey: string; version: string }
    | { ok: false; rejected: "not-found" | "not-a-member" | "self-approval" | "not-open" | "conflict" };
  export async function approveReviewRequest(db: AppDb, args: { accountId: string; requestId: string }, now?: number): Promise<ApproveResult>;
  ```
- Guarantees: (a) approver must be a group member and NOT the author; (b) the `open → approved` transition is a conditional UPDATE so a double-approve loses as a no-op; (c) publishes via `upsertCatalogGem` (`publishedBy` = author login, `ownerAccountId` = author) + `upsertGemArchive`; (d) re-applies the catalog owner-conflict guard (an existing `(gemKey,version)` owned by a different account → `conflict`, transition rolled back); (e) clears `archive_bytes` after publishing.

- [ ] **Step 1: Write the failing test**

Append:

```ts
import { approveReviewRequest, listCatalogGems, getGemArchive } from "@agentgem/aggregator";

describe("approveReviewRequest", () => {
  async function seedOpen() {
    const db = await makeTestDb();
    const author = await upsertAccount(db, { provider: "github", accountId: "a1", login: "alice" });
    const reviewer = await upsertAccount(db, { provider: "github", accountId: "r1", login: "rob" });
    const g = await createNativeGroup(db, author.id, "Team");
    await grantInvite(db, g.id, reviewer.id, "member");
    const r = await submitReviewRequest(db, { accountId: author.id, groupId: g.id, manifest: mkManifest("@team/bot"), archiveBytes: new Uint8Array([7]), archiveDigest: "sha256:x", description: "d" }, 1000);
    if (!r.ok) throw new Error("submit failed");
    return { db, author, reviewer, g, requestId: r.requestId };
  }

  it("a member approval publishes the gem + archive and clears staging bytes", async () => {
    const { db, reviewer, requestId } = await seedOpen();
    const res = await approveReviewRequest(db, { accountId: reviewer.id, requestId }, 2000);
    expect(res).toEqual({ ok: true, gemKey: "@team/bot", version: "1.0.0" });
    const catalog = await listCatalogGems(db);
    expect(catalog.find((c) => c.gemKey === "@team/bot")).toMatchObject({ publishedBy: "alice", installable: true });
    const arch = await getGemArchive(db, "@team/bot", "1.0.0");
    expect(Array.from(arch!.bytes)).toEqual([7]);
    expect(await getReviewArchive(db, reviewer.id, requestId)).toBeNull(); // staging bytes cleared
  });

  it("blocks self-approval by the author", async () => {
    const { db, author, requestId } = await seedOpen();
    expect(await approveReviewRequest(db, { accountId: author.id, requestId })).toEqual({ ok: false, rejected: "self-approval" });
  });

  it("blocks a non-member", async () => {
    const { db, requestId } = await seedOpen();
    const outsider = await upsertAccount(db, { provider: "github", accountId: "x", login: "mallory" });
    expect(await approveReviewRequest(db, { accountId: outsider.id, requestId })).toEqual({ ok: false, rejected: "not-a-member" });
  });

  it("a second approval is a no-op (not-open), gem published exactly once", async () => {
    const { db, reviewer, requestId } = await seedOpen();
    const first = await approveReviewRequest(db, { accountId: reviewer.id, requestId }, 2000);
    expect(first.ok).toBe(true);
    const second = await approveReviewRequest(db, { accountId: reviewer.id, requestId }, 2001);
    expect(second).toEqual({ ok: false, rejected: "not-open" });
  });

  it("rejects with conflict when the (key,version) is already owned by someone else", async () => {
    const { db, reviewer, requestId } = await seedOpen();
    const other = await upsertAccount(db, { provider: "github", accountId: "o2", login: "otto" });
    await upsertCatalogGem(db, { gemKey: "@team/bot", version: "1.0.0", publishedBy: "otto", createdAtMs: 1, ownerAccountId: other.id });
    expect(await approveReviewRequest(db, { accountId: reviewer.id, requestId }, 2000)).toEqual({ ok: false, rejected: "conflict" });
    // transition rolled back — still open
    const detail = await getReviewRequest(db, reviewer.id, requestId);
    expect(detail?.status).toBe("open");
  });
});
```

Note the conflict test seeds the catalog row AFTER submit (so the submit-time `version-published` guard is passed), proving the guard is re-applied at approval — the exact delete-guard-≠-publish-guard class of bug the spec calls out.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/aggregator/__tests__/reviewStaging.test.ts -t approveReviewRequest`
Expected: FAIL — `approveReviewRequest` not exported.

- [ ] **Step 3: Implement approveReviewRequest**

Add `upsertCatalogGem`, `upsertGemArchive` to the catalog import and `catalogGems` to the schema import, then:

```ts
import { catalogGemExists, upsertCatalogGem, upsertGemArchive, type CatalogManifest } from "./catalog.js";
import { reviewRequests, reviewMessages, reviewSeen, accounts, catalogGems, type ReviewStatus } from "./schema.js";

export type ApproveResult =
  | { ok: true; gemKey: string; version: string }
  | { ok: false; rejected: "not-found" | "not-a-member" | "self-approval" | "not-open" | "conflict" };

export async function approveReviewRequest(db: AppDb, args: { accountId: string; requestId: string }, now: number = Date.now()): Promise<ApproveResult> {
  const load = await loadForMember(db, args.accountId, args.requestId);
  if (load.kind === "not-found") return { ok: false, rejected: "not-found" };
  if (load.kind === "not-a-member") return { ok: false, rejected: "not-a-member" };
  const row = load.row;
  if (row.authorAccountId === args.accountId) return { ok: false, rejected: "self-approval" };
  if (row.status !== "open") return { ok: false, rejected: "not-open" };

  // Re-apply the catalog owner-conflict guard AT APPROVAL (publish is a different code path than submit;
  // an intervening publish of the same key/version by another account must not be overwritten).
  const existing = (await db.select({ ownerAccountId: catalogGems.ownerAccountId }).from(catalogGems)
    .where(and(eq(catalogGems.gemKey, row.gemKey), eq(catalogGems.version, row.version))).limit(1))[0];
  if (existing && existing.ownerAccountId !== row.authorAccountId) return { ok: false, rejected: "conflict" };

  // Atomic claim of the transition: only the row still `open` flips. A concurrent approve/withdraw that
  // already moved it updates 0 rows -> not-open (no double publish).
  const claimed = await db.update(reviewRequests)
    .set({ status: "approved", resolvedAtMs: now, archiveBytes: null })
    .where(and(eq(reviewRequests.id, args.requestId), eq(reviewRequests.status, "open")))
    .returning({ id: reviewRequests.id });
  if (claimed.length === 0) return { ok: false, rejected: "not-open" };

  // Publish through the normal functions. publishedBy/owner are the AUTHOR's, never the approver's.
  const authorLogin = (await db.select({ login: accounts.login }).from(accounts).where(eq(accounts.id, row.authorAccountId)).limit(1))[0]?.login ?? row.authorAccountId;
  const m = row.manifest as unknown as CatalogManifest;
  await upsertCatalogGem(db, {
    gemKey: row.gemKey, version: row.version, publishedBy: authorLogin, ownerAccountId: row.authorAccountId,
    author: m.author, description: m.description ?? row.description ?? undefined, tags: m.tags,
    artifactKinds: m.artifactKinds, type: m.type, grade: m.grade, artifacts: m.artifacts, createdAtMs: now,
  });
  if (row.archiveBytes != null) {
    await upsertGemArchive(db, { gemKey: row.gemKey, version: row.version, bytes: row.archiveBytes, digest: row.archiveDigest, createdAtMs: now, ownerAccountId: row.authorAccountId });
  }
  return { ok: true, gemKey: row.gemKey, version: row.version };
}
```

Note: `row.archiveBytes` is read into `row` before the UPDATE nulls the column, so the publish still has the bytes. (Drizzle's `.returning()` on the UPDATE is only used to detect the claim; the bytes come from the earlier `load`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/aggregator/__tests__/reviewStaging.test.ts -t approveReviewRequest`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Commit**

```bash
git add packages/aggregator/src/reviewStaging.ts src/aggregator/__tests__/reviewStaging.test.ts
git commit -m "feat(aggregator): approveReviewRequest — atomic publish, self-approval + conflict guards"
```

---

## Task 6: `requestChanges`, `resubmitReviewRequest`, `withdrawReviewRequest`

**Files:**
- Modify: `packages/aggregator/src/reviewStaging.ts`
- Test: `src/aggregator/__tests__/reviewStaging.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ChangesResult = { ok: true } | { ok: false; rejected: "not-found" | "not-a-member" | "self" | "not-open" };
  export async function requestChanges(db: AppDb, args: { accountId: string; requestId: string }, now?: number): Promise<ChangesResult>;
  export type ResubmitResult = { ok: true } | { ok: false; rejected: "not-found" | "forbidden" | "not-changes-requested" };
  export async function resubmitReviewRequest(db: AppDb, args: { accountId: string; requestId: string; manifest: CatalogManifest; archiveBytes: Uint8Array; archiveDigest: string; description?: string }, now?: number): Promise<ResubmitResult>;
  export type WithdrawResult = { ok: true } | { ok: false; rejected: "not-found" | "forbidden" | "not-open" };
  export async function withdrawReviewRequest(db: AppDb, args: { accountId: string; requestId: string }, now?: number): Promise<WithdrawResult>;
  ```
- `requestChanges`: member, not author, atomic `open → changes-requested`.
- `resubmitReviewRequest`: **author only**, `changes-requested → open` with new bytes/manifest, and clears all `review_seen` markers for the request (everyone's badge goes unread again).
- `withdrawReviewRequest`: **author only**, `open → withdrawn`, bytes cleared, row kept for history.

- [ ] **Step 1: Write the failing test**

Append:

```ts
import { requestChanges, resubmitReviewRequest, withdrawReviewRequest } from "@agentgem/aggregator";

describe("requestChanges / resubmit / withdraw", () => {
  async function seedOpen() {
    const db = await makeTestDb();
    const author = await upsertAccount(db, { provider: "github", accountId: "a1", login: "alice" });
    const reviewer = await upsertAccount(db, { provider: "github", accountId: "r1", login: "rob" });
    const g = await createNativeGroup(db, author.id, "Team");
    await grantInvite(db, g.id, reviewer.id, "member");
    const r = await submitReviewRequest(db, { accountId: author.id, groupId: g.id, manifest: mkManifest("@team/bot"), archiveBytes: new Uint8Array([1]), archiveDigest: "sha256:x", description: "d" }, 1000);
    if (!r.ok) throw new Error("submit failed");
    return { db, author, reviewer, requestId: r.requestId };
  }

  it("reviewer requests changes; author resubmits back to open with new bytes; seen markers cleared", async () => {
    const { db, author, reviewer, requestId } = await seedOpen();
    await markSeen(db, reviewer.id, requestId, 1100);
    expect(await requestChanges(db, { accountId: reviewer.id, requestId }, 1200)).toEqual({ ok: true });
    let detail = await getReviewRequest(db, reviewer.id, requestId);
    expect(detail?.status).toBe("changes-requested");
    const rs = await resubmitReviewRequest(db, { accountId: author.id, requestId, manifest: mkManifest("@team/bot"), archiveBytes: new Uint8Array([2, 2]), archiveDigest: "sha256:y" }, 1300);
    expect(rs).toEqual({ ok: true });
    detail = await getReviewRequest(db, reviewer.id, requestId);
    expect(detail?.status).toBe("open");
    const arch = await getReviewArchive(db, author.id, requestId);
    expect(Array.from(arch!.bytes)).toEqual([2, 2]);
    // reviewer's badge is unread again after resubmit
    const inbox = await listInbox(db, reviewer.id);
    expect(inbox.find((x) => x.id === requestId)?.unread).toBe(true);
  });

  it("author cannot self-request-changes; reviewer cannot resubmit or withdraw", async () => {
    const { db, author, reviewer, requestId } = await seedOpen();
    expect(await requestChanges(db, { accountId: author.id, requestId })).toEqual({ ok: false, rejected: "self" });
    expect(await resubmitReviewRequest(db, { accountId: reviewer.id, requestId, manifest: mkManifest("@team/bot"), archiveBytes: new Uint8Array([1]), archiveDigest: "z" })).toEqual({ ok: false, rejected: "not-changes-requested" });
    expect(await withdrawReviewRequest(db, { accountId: reviewer.id, requestId })).toEqual({ ok: false, rejected: "forbidden" });
  });

  it("author withdraws an open request; bytes cleared, status withdrawn, drops off inbox", async () => {
    const { db, author, reviewer, requestId } = await seedOpen();
    expect(await withdrawReviewRequest(db, { accountId: author.id, requestId }, 1400)).toEqual({ ok: true });
    expect(await getReviewArchive(db, reviewer.id, requestId)).toBeNull();
    expect((await getReviewRequest(db, reviewer.id, requestId))?.status).toBe("withdrawn");
    expect(await listInbox(db, reviewer.id)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/aggregator/__tests__/reviewStaging.test.ts -t "requestChanges / resubmit / withdraw"`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement the three functions**

Add to `reviewStaging.ts`:

```ts
export type ChangesResult = { ok: true } | { ok: false; rejected: "not-found" | "not-a-member" | "self" | "not-open" };
export async function requestChanges(db: AppDb, args: { accountId: string; requestId: string }, now: number = Date.now()): Promise<ChangesResult> {
  const load = await loadForMember(db, args.accountId, args.requestId);
  if (load.kind === "not-found") return { ok: false, rejected: "not-found" };
  if (load.kind === "not-a-member") return { ok: false, rejected: "not-a-member" };
  if (load.row.authorAccountId === args.accountId) return { ok: false, rejected: "self" };
  const claimed = await db.update(reviewRequests)
    .set({ status: "changes-requested", resolvedAtMs: now })
    .where(and(eq(reviewRequests.id, args.requestId), eq(reviewRequests.status, "open")))
    .returning({ id: reviewRequests.id });
  return claimed.length ? { ok: true } : { ok: false, rejected: "not-open" };
}

export type ResubmitResult = { ok: true } | { ok: false; rejected: "not-found" | "forbidden" | "not-changes-requested" };
export async function resubmitReviewRequest(
  db: AppDb,
  args: { accountId: string; requestId: string; manifest: CatalogManifest; archiveBytes: Uint8Array; archiveDigest: string; description?: string },
  now: number = Date.now(),
): Promise<ResubmitResult> {
  const row = (await db.select().from(reviewRequests).where(eq(reviewRequests.id, args.requestId)).limit(1))[0];
  if (!row) return { ok: false, rejected: "not-found" };
  if (row.authorAccountId !== args.accountId) return { ok: false, rejected: "forbidden" };
  const claimed = await db.update(reviewRequests)
    .set({
      status: "open", resolvedAtMs: null,
      manifest: args.manifest as unknown as Record<string, unknown>,
      archiveBytes: args.archiveBytes, archiveDigest: args.archiveDigest,
      description: args.description ?? row.description ?? null,
    })
    .where(and(eq(reviewRequests.id, args.requestId), eq(reviewRequests.status, "changes-requested")))
    .returning({ id: reviewRequests.id });
  if (claimed.length === 0) return { ok: false, rejected: "not-changes-requested" };
  await db.delete(reviewSeen).where(eq(reviewSeen.requestId, args.requestId)); // everyone's badge unread again
  return { ok: true };
}

export type WithdrawResult = { ok: true } | { ok: false; rejected: "not-found" | "forbidden" | "not-open" };
export async function withdrawReviewRequest(db: AppDb, args: { accountId: string; requestId: string }, now: number = Date.now()): Promise<WithdrawResult> {
  const row = (await db.select().from(reviewRequests).where(eq(reviewRequests.id, args.requestId)).limit(1))[0];
  if (!row) return { ok: false, rejected: "not-found" };
  if (row.authorAccountId !== args.accountId) return { ok: false, rejected: "forbidden" };
  const claimed = await db.update(reviewRequests)
    .set({ status: "withdrawn", resolvedAtMs: now, archiveBytes: null })
    .where(and(eq(reviewRequests.id, args.requestId), eq(reviewRequests.status, "open")))
    .returning({ id: reviewRequests.id });
  return claimed.length ? { ok: true } : { ok: false, rejected: "not-open" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/aggregator/__tests__/reviewStaging.test.ts -t "requestChanges / resubmit / withdraw"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/aggregator/src/reviewStaging.ts src/aggregator/__tests__/reviewStaging.test.ts
git commit -m "feat(aggregator): requestChanges / resubmit / withdraw transitions"
```

---

## Task 7: Cleanup on member removal (`withdrawRequestsForDepartedMember`)

**Files:**
- Modify: `packages/aggregator/src/reviewStaging.ts`
- Modify: `packages/aggregator/src/groups.ts` (call cleanup from `removeMemberGuarded`)
- Test: `src/aggregator/__tests__/reviewStaging.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export async function withdrawRequestsForDepartedMember(db: AppDb, groupId: string, accountId: string, now?: number): Promise<{ withdrawn: number }>;
  ```
- Withdraws (status → `withdrawn`, bytes cleared) every `open`/`changes-requested` request in `groupId` authored by `accountId`. Called by `removeMemberGuarded` after a successful removal so a departed author leaves no live staging gem behind. Idempotent.

- [ ] **Step 1: Write the failing test**

Append:

```ts
import { withdrawRequestsForDepartedMember, removeMemberGuarded } from "@agentgem/aggregator";

describe("member-removal cleanup", () => {
  it("removing an author from a group withdraws their open requests", async () => {
    const db = await makeTestDb();
    const admin = await upsertAccount(db, { provider: "github", accountId: "ad", login: "admin" });
    const author = await upsertAccount(db, { provider: "github", accountId: "a1", login: "alice" });
    const g = await createNativeGroup(db, admin.id, "Team");
    await grantInvite(db, g.id, author.id, "member");
    const r = await submitReviewRequest(db, { accountId: author.id, groupId: g.id, manifest: mkManifest("@team/bot"), archiveBytes: new Uint8Array([1]), archiveDigest: "x" }, 1000);
    if (!r.ok) throw new Error("submit failed");

    const removed = await removeMemberGuarded(db, g.id, author.id);
    expect(removed).toBe("removed");
    // author's request is now withdrawn, its bytes gone; admin's inbox no longer shows it
    expect(await listInbox(db, admin.id)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/aggregator/__tests__/reviewStaging.test.ts -t "member-removal cleanup"`
Expected: FAIL — `withdrawRequestsForDepartedMember` not exported / cleanup not wired.

- [ ] **Step 3: Implement cleanup + wire into removeMemberGuarded**

Add to `reviewStaging.ts`:

```ts
export async function withdrawRequestsForDepartedMember(db: AppDb, groupId: string, accountId: string, now: number = Date.now()): Promise<{ withdrawn: number }> {
  const res = await db.update(reviewRequests)
    .set({ status: "withdrawn", resolvedAtMs: now, archiveBytes: null })
    .where(and(eq(reviewRequests.groupId, groupId), eq(reviewRequests.authorAccountId, accountId), inArray(reviewRequests.status, ["open", "changes-requested"])))
    .returning({ id: reviewRequests.id });
  return { withdrawn: res.length };
}
```

In `packages/aggregator/src/groups.ts`, import the cleanup and call it from `removeMemberGuarded` on the successful-removal path only. Add near the top:

```ts
import { withdrawRequestsForDepartedMember } from "./reviewStaging.js";
```

Then in `removeMemberGuarded`, immediately before `return "removed";`:

```ts
  await withdrawRequestsForDepartedMember(db, groupId, accountId);
  return "removed";
```

⚠️ **Circular-import check:** `reviewStaging.ts` imports from `groups.ts` (`groupMemberRole`, `listGroupsForAccount`) and `groups.ts` now imports from `reviewStaging.ts`. ESM handles this cycle as long as neither uses the other at module-evaluation time — both only reference the other inside function bodies, so it is safe. Verify by running the full build in Step 4; a cycle problem surfaces as `undefined is not a function` at call time.

- [ ] **Step 4: Run test + full build to verify it passes**

Run: `pnpm test -- src/aggregator/__tests__/reviewStaging.test.ts` (runs `tsc -b` first, catching the import cycle if it mis-orders).
Expected: PASS. If `tsc -b` errors, fix imports before proceeding.

- [ ] **Step 5: Commit**

```bash
git add packages/aggregator/src/reviewStaging.ts packages/aggregator/src/groups.ts src/aggregator/__tests__/reviewStaging.test.ts
git commit -m "feat(aggregator): withdraw a departed member's open review requests"
```

---

## Task 8: Signed HTTP routes on AggregatorController

**Files:**
- Modify: `src/aggregator.controller.ts`
- Test: `src/aggregator/__tests__/reviewStagingController.test.ts`

**Interfaces:**
- Consumes: `resolveSignedAccount` (catalog.ts), `catalogSigningPayload` (catalog.ts, reused for submit/resubmit which sign a manifest), all Task 2–7 store functions, `importGem` (already imported in the controller for `/publish-gem`).
- Produces these routes under `@api({ basePath: "/api/aggregator" })`:
  | Method | Path | Body (Zod) | Auth payload signed |
  |---|---|---|---|
  | POST | `/review/request` | `{ manifest, archiveBase64, groupId, description?, pubkey, signedAt, signature }` | `catalogSigningPayload(manifest, pubkey, signedAt)` |
  | POST | `/review/resubmit` | `{ requestId, manifest, archiveBase64, description?, pubkey, signedAt, signature }` | `catalogSigningPayload(manifest, pubkey, signedAt)` |
  | POST | `/review/inbox` | `{ pubkey, signedAt, signature }` | `reviewActionPayload("inbox", "", pubkey, signedAt)` |
  | POST | `/review/get` | `{ requestId, pubkey, signedAt, signature }` | `reviewActionPayload("get", requestId, pubkey, signedAt)` |
  | POST | `/review/archive` | `{ requestId, pubkey, signedAt, signature }` | `reviewActionPayload("archive", requestId, ...)` |
  | POST | `/review/message` | `{ requestId, body, pubkey, signedAt, signature }` | `reviewActionPayload("message:"+body, requestId, ...)` |
  | POST | `/review/approve` | `{ requestId, pubkey, signedAt, signature }` | `reviewActionPayload("approve", requestId, ...)` |
  | POST | `/review/changes` | `{ requestId, pubkey, signedAt, signature }` | `reviewActionPayload("changes", requestId, ...)` |
  | POST | `/review/withdraw` | `{ requestId, pubkey, signedAt, signature }` | `reviewActionPayload("withdraw", requestId, ...)` |
  | POST | `/review/seen` | `{ requestId, pubkey, signedAt, signature }` | `reviewActionPayload("seen", requestId, ...)` |

  All reads are POST because the signature travels in the body (same reason `/game-play` is POST). `reviewActionPayload` is a new exported helper in `catalog.ts` (co-located with `catalogSigningPayload`):
  ```ts
  export function reviewActionPayload(action: string, requestId: string, pubkey: string, signedAt: number): string;
  ```

- [ ] **Step 1: Write the failing test (representative: submit → inbox → approve over HTTP)**

Create `src/aggregator/__tests__/reviewStagingController.test.ts`. Model the signer + seeding on `catalogController.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { makeTestDb, upsertAccount, createNativeGroup, grantInvite, producers, accountBindings, catalogSigningPayload, reviewActionPayload } from "@agentgem/aggregator";
import { AggregatorController } from "../../aggregator.controller.js";

// ed25519 signer identical in shape to catalogController.test.ts's helper.
function signer() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  const pubkey = "ed25519:" + Buffer.from(spki).toString("base64");
  return { pubkey, sign: (payload: string) => Buffer.from(edSign(null, Buffer.from(payload), privateKey)).toString("base64") };
}

// Bind a signer's pubkey to a seeded account so resolveSignedAccount maps key -> accounts.id.
async function bind(db: any, pubkey: string, acct: { id: string; login: string }) {
  await db.insert(producers).values({ pubkey }).onConflictDoNothing();
  await db.insert(accountBindings).values({ pubkey, provider: "github", accountId: acct.login, accountLogin: acct.login });
}

const manifest = { gemKey: "@team/bot", version: "1.0.0", description: "d", gemDigest: "sha256:00" };

it("submit -> inbox -> approve over the signed HTTP surface", async () => {
  const db = await makeTestDb();
  const author = await upsertAccount(db, { provider: "github", accountId: "alice", login: "alice" });
  const reviewer = await upsertAccount(db, { provider: "github", accountId: "rob", login: "rob" });
  const g = await createNativeGroup(db, author.id, "Team");
  await grantInvite(db, g.id, reviewer.id, "member");
  const aliceKey = signer(); await bind(db, aliceKey.pubkey, { id: author.id, login: "alice" });
  const robKey = signer(); await bind(db, robKey.pubkey, { id: reviewer.id, login: "rob" });
  const c = new AggregatorController(db);

  const now = Date.now();
  const sub = await c.reviewRequest({ body: {
    manifest, archiveBase64: Buffer.from([1, 2, 3]).toString("base64"), groupId: g.id, description: "please",
    pubkey: aliceKey.pubkey, signedAt: now, signature: aliceKey.sign(catalogSigningPayload(manifest as any, aliceKey.pubkey, now)),
  } });
  expect(sub.ok).toBe(true);
  const requestId = (sub as { ok: true; requestId: string }).requestId;

  const inboxAt = Date.now();
  const inbox = await c.reviewInbox({ body: { pubkey: robKey.pubkey, signedAt: inboxAt, signature: robKey.sign(reviewActionPayload("inbox", "", robKey.pubkey, inboxAt)) } });
  expect(inbox.requests.map((r) => r.id)).toContain(requestId);

  const apAt = Date.now();
  const ap = await c.reviewApprove({ body: { requestId, pubkey: robKey.pubkey, signedAt: apAt, signature: robKey.sign(reviewActionPayload("approve", requestId, robKey.pubkey, apAt)) } });
  expect(ap).toMatchObject({ ok: true, gemKey: "@team/bot", version: "1.0.0" });
});

it("rejects a bad signature with a 4xx AgentError", async () => {
  const db = await makeTestDb();
  const c = new AggregatorController(db);
  const at = Date.now();
  await expect(c.reviewInbox({ body: { pubkey: "ed25519:AAAA", signedAt: at, signature: "bad" } }))
    .rejects.toThrow(); // AgentError, status 401
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/aggregator/__tests__/reviewStagingController.test.ts`
Expected: FAIL — `reviewActionPayload` and the controller methods do not exist.

- [ ] **Step 3a: Add `reviewActionPayload` to catalog.ts**

In `packages/aggregator/src/catalog.ts`, next to `catalogSigningPayload` (line ~184):

```ts
// Canonical payload for a review-staging action that has no manifest to sign (approve/changes/
// withdraw/seen/get/archive/message/inbox). Binds the action verb + target request id so a captured
// signature for one action can't be replayed as another. `requestId` is "" for the inbox list.
export function reviewActionPayload(action: string, requestId: string, pubkey: string, signedAt: number): string {
  return canonicalJSON({ scope: "review", action, requestId, pubkey, signedAt });
}
```

- [ ] **Step 3b: Add Zod schemas + route methods to aggregator.controller.ts**

Near the other body schemas (aggregator.controller.ts ~line 142), add:

```ts
const ReviewManifestWrite = z.object({
  manifest: CatalogManifestSchema, archiveBase64: z.string(), groupId: z.string().uuid(),
  description: z.string().max(4000).optional(), pubkey: z.string(), signedAt: z.number(), signature: z.string(),
});
const ReviewResubmit = z.object({
  requestId: z.string().uuid(), manifest: CatalogManifestSchema, archiveBase64: z.string(),
  description: z.string().max(4000).optional(), pubkey: z.string(), signedAt: z.number(), signature: z.string(),
});
const ReviewSigned = z.object({ requestId: z.string().uuid(), pubkey: z.string(), signedAt: z.number(), signature: z.string() });
const ReviewMessageBody = ReviewSigned.extend({ body: z.string().min(1).max(4000) });
const ReviewInboxBody = z.object({ pubkey: z.string(), signedAt: z.number(), signature: z.string() });

const ReviewSubmitResult = z.object({ ok: z.boolean(), requestId: z.string().optional(), rejected: z.string().optional() });
const ReviewActionResult = z.object({ ok: z.boolean(), gemKey: z.string().optional(), version: z.string().optional(), rejected: z.string().optional() });
const ReviewInboxResult = z.object({ requests: z.array(z.any()) });
const ReviewDetailResult = z.object({ request: z.any().nullable() });
const ReviewArchiveResult = z.object({ archiveBase64: z.string().nullable() });
```

Then add the methods inside the controller class. `signed(...)` is a small private helper resolving the account or throwing a 401 `AgentError`:

```ts
private async signedAccount(payload: string, body: { pubkey: string; signedAt: number; signature: string }) {
  const who = await resolveSignedAccount(this.db, { pubkey: body.pubkey, payload, signedAt: body.signedAt, signature: body.signature });
  if (!who.ok) throw new AgentError("not authorized", { status: 401, code: "review_unauthorized", retryable: false });
  return who; // { ok:true, accountId, login }
}

@post("/review/request", { body: ReviewManifestWrite, response: ReviewSubmitResult })
async reviewRequest(input: { body: z.infer<typeof ReviewManifestWrite> }): Promise<z.infer<typeof ReviewSubmitResult>> {
  const b = input.body;
  const who = await this.signedAccount(catalogSigningPayload(b.manifest, b.pubkey, b.signedAt), b);
  const bytes = new Uint8Array(Buffer.from(b.archiveBase64, "base64"));
  const digest = importGem(bytes).meta.gemDigest; // validates the .gem, throws AgentError on bad archive (reuse /publish-gem's guard)
  const r = await submitReviewRequest(this.db, { accountId: who.accountId, groupId: b.groupId, manifest: b.manifest, archiveBytes: bytes, archiveDigest: digest, description: b.description });
  return r.ok ? { ok: true, requestId: r.requestId } : { ok: false, rejected: r.rejected };
}

@post("/review/resubmit", { body: ReviewResubmit, response: ReviewActionResult })
async reviewResubmit(input: { body: z.infer<typeof ReviewResubmit> }): Promise<z.infer<typeof ReviewActionResult>> {
  const b = input.body;
  const who = await this.signedAccount(catalogSigningPayload(b.manifest, b.pubkey, b.signedAt), b);
  const bytes = new Uint8Array(Buffer.from(b.archiveBase64, "base64"));
  const digest = importGem(bytes).meta.gemDigest;
  const r = await resubmitReviewRequest(this.db, { accountId: who.accountId, requestId: b.requestId, manifest: b.manifest, archiveBytes: bytes, archiveDigest: digest, description: b.description });
  return r.ok ? { ok: true } : { ok: false, rejected: r.rejected };
}

@post("/review/inbox", { body: ReviewInboxBody, response: ReviewInboxResult })
async reviewInbox(input: { body: z.infer<typeof ReviewInboxBody> }): Promise<z.infer<typeof ReviewInboxResult>> {
  const who = await this.signedAccount(reviewActionPayload("inbox", "", input.body.pubkey, input.body.signedAt), input.body);
  return { requests: await listInbox(this.db, who.accountId) };
}

@post("/review/get", { body: ReviewSigned, response: ReviewDetailResult })
async reviewGet(input: { body: z.infer<typeof ReviewSigned> }): Promise<z.infer<typeof ReviewDetailResult>> {
  const who = await this.signedAccount(reviewActionPayload("get", input.body.requestId, input.body.pubkey, input.body.signedAt), input.body);
  await markSeen(this.db, who.accountId, input.body.requestId); // opening the detail marks it read
  return { request: await getReviewRequest(this.db, who.accountId, input.body.requestId) };
}

@post("/review/archive", { body: ReviewSigned, response: ReviewArchiveResult })
async reviewArchive(input: { body: z.infer<typeof ReviewSigned> }): Promise<z.infer<typeof ReviewArchiveResult>> {
  const who = await this.signedAccount(reviewActionPayload("archive", input.body.requestId, input.body.pubkey, input.body.signedAt), input.body);
  const a = await getReviewArchive(this.db, who.accountId, input.body.requestId);
  return { archiveBase64: a ? Buffer.from(a.bytes).toString("base64") : null };
}

@post("/review/message", { body: ReviewMessageBody, response: ReviewActionResult })
async reviewMessage(input: { body: z.infer<typeof ReviewMessageBody> }): Promise<z.infer<typeof ReviewActionResult>> {
  const b = input.body;
  const who = await this.signedAccount(reviewActionPayload("message:" + b.body, b.requestId, b.pubkey, b.signedAt), b);
  const r = await addReviewMessage(this.db, { accountId: who.accountId, requestId: b.requestId, body: b.body });
  return r.ok ? { ok: true } : { ok: false, rejected: r.rejected };
}

@post("/review/approve", { body: ReviewSigned, response: ReviewActionResult })
async reviewApprove(input: { body: z.infer<typeof ReviewSigned> }): Promise<z.infer<typeof ReviewActionResult>> {
  const who = await this.signedAccount(reviewActionPayload("approve", input.body.requestId, input.body.pubkey, input.body.signedAt), input.body);
  const r = await approveReviewRequest(this.db, { accountId: who.accountId, requestId: input.body.requestId });
  return r.ok ? { ok: true, gemKey: r.gemKey, version: r.version } : { ok: false, rejected: r.rejected };
}

@post("/review/changes", { body: ReviewSigned, response: ReviewActionResult })
async reviewChanges(input: { body: z.infer<typeof ReviewSigned> }): Promise<z.infer<typeof ReviewActionResult>> {
  const who = await this.signedAccount(reviewActionPayload("changes", input.body.requestId, input.body.pubkey, input.body.signedAt), input.body);
  const r = await requestChanges(this.db, { accountId: who.accountId, requestId: input.body.requestId });
  return r.ok ? { ok: true } : { ok: false, rejected: r.rejected };
}

@post("/review/withdraw", { body: ReviewSigned, response: ReviewActionResult })
async reviewWithdraw(input: { body: z.infer<typeof ReviewSigned> }): Promise<z.infer<typeof ReviewActionResult>> {
  const who = await this.signedAccount(reviewActionPayload("withdraw", input.body.requestId, input.body.pubkey, input.body.signedAt), input.body);
  const r = await withdrawReviewRequest(this.db, { accountId: who.accountId, requestId: input.body.requestId });
  return r.ok ? { ok: true } : { ok: false, rejected: r.rejected };
}

@post("/review/seen", { body: ReviewSigned, response: ReviewActionResult })
async reviewSeen(input: { body: z.infer<typeof ReviewSigned> }): Promise<z.infer<typeof ReviewActionResult>> {
  const who = await this.signedAccount(reviewActionPayload("seen", input.body.requestId, input.body.pubkey, input.body.signedAt), input.body);
  await markSeen(this.db, who.accountId, input.body.requestId);
  return { ok: true };
}
```

Add the imports at the top of `aggregator.controller.ts` (extend the existing `@agentgem/aggregator` import):

```ts
import {
  /* ...existing... */
  resolveSignedAccount, catalogSigningPayload, reviewActionPayload,
  submitReviewRequest, resubmitReviewRequest, listInbox, getReviewRequest, getReviewArchive,
  addReviewMessage, approveReviewRequest, requestChanges, withdrawReviewRequest, markSeen,
} from "@agentgem/aggregator";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- src/aggregator/__tests__/reviewStagingController.test.ts`
Expected: PASS (both cases). The `tsc -b` step must be clean.

- [ ] **Step 5: Add the remaining controller tests, then commit**

Add these cases to `reviewStagingController.test.ts` (full assertions, not placeholders):

```ts
it("self-approval over HTTP is rejected", async () => {
  const db = await makeTestDb();
  const author = await upsertAccount(db, { provider: "github", accountId: "alice", login: "alice" });
  const g = await createNativeGroup(db, author.id, "Team");
  const k = signer(); await bind(db, k.pubkey, { id: author.id, login: "alice" });
  const c = new AggregatorController(db);
  const now = Date.now();
  const sub = await c.reviewRequest({ body: { manifest, archiveBase64: Buffer.from([1]).toString("base64"), groupId: g.id, pubkey: k.pubkey, signedAt: now, signature: k.sign(catalogSigningPayload(manifest as any, k.pubkey, now)) } });
  const requestId = (sub as any).requestId;
  const at = Date.now();
  const res = await c.reviewApprove({ body: { requestId, pubkey: k.pubkey, signedAt: at, signature: k.sign(reviewActionPayload("approve", requestId, k.pubkey, at)) } });
  expect(res).toEqual({ ok: false, rejected: "self-approval" });
});

it("a signature bound to one action cannot be replayed for another", async () => {
  const db = await makeTestDb();
  const author = await upsertAccount(db, { provider: "github", accountId: "alice", login: "alice" });
  const reviewer = await upsertAccount(db, { provider: "github", accountId: "rob", login: "rob" });
  const g = await createNativeGroup(db, author.id, "Team");
  await grantInvite(db, g.id, reviewer.id, "member");
  const ak = signer(); await bind(db, ak.pubkey, { id: author.id, login: "alice" });
  const rk = signer(); await bind(db, rk.pubkey, { id: reviewer.id, login: "rob" });
  const c = new AggregatorController(db);
  const now = Date.now();
  const sub = await c.reviewRequest({ body: { manifest, archiveBase64: Buffer.from([1]).toString("base64"), groupId: g.id, pubkey: ak.pubkey, signedAt: now, signature: ak.sign(catalogSigningPayload(manifest as any, ak.pubkey, now)) } });
  const requestId = (sub as any).requestId;
  const at = Date.now();
  // A signature for "withdraw" replayed against the approve route must fail the signature check.
  const stolen = rk.sign(reviewActionPayload("withdraw", requestId, rk.pubkey, at));
  await expect(c.reviewApprove({ body: { requestId, pubkey: rk.pubkey, signedAt: at, signature: stolen } })).rejects.toThrow();
});
```

Run: `pnpm test -- src/aggregator/__tests__/reviewStagingController.test.ts` → PASS.

```bash
git add src/aggregator.controller.ts packages/aggregator/src/catalog.ts src/aggregator/__tests__/reviewStagingController.test.ts
git commit -m "feat(aggregator): signed /api/aggregator/review/* routes"
```

---

## Task 9: Full-suite regression + PR

**Files:** none new.

- [ ] **Step 1: Run the entire test suite**

Run: `pnpm test`
Expected: PASS. If any pre-existing test fails, confirm it also fails on `origin/main` (note it in the PR); do not let it block, but do not mask a regression your change caused.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin feat/gem-review-staging
gh pr create --title "feat: gem review staging — backend core (Plan 1 of 2)" --body "$(cat <<'EOF'
Backend for review-gated gem staging (team collaboration slice D). Store state machine
+ signed /api/aggregator/review/* routes. No UI (Plan 2 wires the console).

Spec: docs/superpowers/specs/2026-07-10-gem-review-staging-design.md

## Guards verified by tests
- member-gated submit; version-already-published + slash-less-key rejects
- membership-gated detail/archive/message reads (non-member -> null/not-found)
- self-approval blocked; approve is an atomic open->approved claim (double-approve = no-op)
- owner-conflict guard RE-APPLIED at approval (not just submit)
- resubmit clears seen markers; withdraw + departed-member cleanup

## ⚠️ CI gap
Root `test (24)` gates only `dist/__tests__`. The new aggregator store + controller tests
(`src/aggregator/__tests__/reviewStaging*.test.ts`) do NOT run in CI. They were run locally
via `pnpm test`. Wiring them into CI is a separate follow-up.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Watch CI, merge per repo convention**

```bash
gh run watch <run-id> --exit-status && gh pr merge --rebase --delete-branch
```
Then verify each commit's content landed on `origin/main` (`git fetch` + grep `origin/main:packages/aggregator/src/reviewStaging.ts`), per the repo's dropped-commit trap.

---

## Self-Review

**1. Spec coverage** (spec §Section 1–4 → task):
- §1 staging status + data model → Tasks 1, 2 (refined: bytes/manifest on `review_requests`, not a `catalog_gems` status — flagged in the plan header and File Structure). ✓
- §1 lifecycle (submit/approve/request-changes/withdraw/resubmit) → Tasks 2, 5, 6. ✓
- §1 "publishing respects ownership guards" → Task 5 re-applies the catalog owner-conflict guard at approval (the concrete, existing publish guard; the spec's broader "scope-ownership" wording is narrowed to what `recordCatalogShare` actually enforces — noted). ✓
- §2 `review_messages` conversation + membership-gated surfaces → Task 4. ✓
- §2 "both sides in the console / install-to-test" → the archive-fetch endpoint (Task 4 `getReviewArchive` + Task 8 `/review/archive`) is the backend half; the console UI is Plan 2. ✓ (backend obligations met)
- §3 inbox badge + `review_seen` `last_seen_at` → Task 3 (`listInbox` `unread`, `markSeen`); §3 "transitions as named events for a later Slack webhook" → NOT built (spec defers it); the transition functions are the single choke points a webhook would later hook, satisfying "seam left clean." ✓ (deferred as speced)
- §4 self-approval, atomic transitions, scope/owner re-check, version collision, resubmit-reuses-request, departed-member cleanup, withdraw-keeps-history → Tasks 2, 5, 6, 7. ✓
- §4 testing (aggregator state machine) → Tasks 2–8; §4 CI caveat → Global Constraints + Task 9 PR body. ✓

**2. Placeholder scan:** no TBD/TODO; every code step shows real code; the one intentional dead line in Task 4 Step 3 (`const groupName = ...`) is explicitly called out for deletion in the same step. ✓

**3. Type consistency:** `submitReviewRequest`/`resubmitReviewRequest` share the `{ manifest, archiveBytes, archiveDigest, description? }` arg shape; `ReviewRequestSummary` (Task 3) is extended by `ReviewRequestDetail` (Task 4); controller methods reference the exact store fn names exported in Tasks 2–7; `reviewActionPayload` is defined in Task 8 Step 3a before its first use in Step 3b/tests. Store fns all take a trailing `now?: number`. ✓

## Follow-on: Plan 2 (console integration)

Not in this plan. Plan 2 will: (a) add local backend signing routes that mirror `src/gem/catalogShareClient.ts` to call `/api/aggregator/review/*`; (b) add a "Request review" button + group-picker to `packages/console/src/panels/Play/Studio.tsx`; (c) add a `panels/Reviews/` inbox panel + `reviewsPage` registered in `pages.tsx`, using the Watch fetch-list + NotificationsProvider polling idioms for a live unread badge. It depends on the routes this plan ships.
