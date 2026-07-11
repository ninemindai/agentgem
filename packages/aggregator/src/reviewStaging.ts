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
import { accounts, catalogGems, reviewMessages, reviewRequests, reviewSeen, type ReviewStatus } from "./schema.js";
import { groupMemberRole, listGroupsForAccount } from "./groups.js";
import { accountOwnsScope } from "./webAuth.js";
import { catalogGemExists, clampGrade, upsertCatalogGem, upsertGemArchive, type CatalogManifest } from "./catalog.js";

/** "@acme/bot" -> "acme"; "" for a malformed/slash-less key (caller rejects that as invalid-key
 *  first, so "" never reaches accountOwnsScope). The scope is everything between the leading "@"
 *  and the first "/". */
export function gemScope(gemKey: string): string {
  const slash = gemKey.indexOf("/");
  if (slash < 0) return "";
  return gemKey.slice(gemKey.startsWith("@") ? 1 : 0, slash);
}

export type SubmitResult =
  | { ok: true; requestId: string }
  | { ok: false; rejected: "not-a-member" | "not-scope-owner" | "version-published" | "invalid-key" };

export async function submitReviewRequest(
  db: AppDb,
  args: { accountId: string; groupId: string; manifest: CatalogManifest; archiveBytes: Uint8Array; archiveDigest: string; description?: string },
  now: number = Date.now(),
): Promise<SubmitResult> {
  // Same key rule as recordCatalogShare: a published key is scope/name and ALWAYS contains "/".
  if (!args.manifest.gemKey.includes("/")) return { ok: false, rejected: "invalid-key" };
  if ((await groupMemberRole(db, args.groupId, args.accountId)) === null) return { ok: false, rejected: "not-a-member" };
  // Scope-ownership guard (D2): you may only stage under a scope you own — your handle, or an org
  // membership captured at sign-in/bind. Re-checked at approval (that is the actual publish). This
  // is a guard the raw publish path lacks; the review flow adds it because it makes staging under an
  // arbitrary scope a one-click team action otherwise.
  if (!(await accountOwnsScope(db, args.accountId, gemScope(args.manifest.gemKey)))) return { ok: false, rejected: "not-scope-owner" };
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

export interface ReviewRequestSummary {
  id: string; groupId: string; groupName: string; gemKey: string; version: string;
  authorAccountId: string; authorLogin: string | null; status: ReviewStatus;
  description: string | null; createdAtMs: number; resolvedAtMs: number | null;
  messageCount: number; unread: boolean;
}

/** Open/changes-requested requests across every group the viewer belongs to, newest activity
 *  first. `unread` compares the request's last activity (its own createdAtMs, or a later message)
 *  against this account's review_seen marker for the request — a missing marker is unread. */
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

/** Marks `requestId` as seen by `accountId` at `now`, upserting the review_seen marker.
 *  Gate: only a member of the request's group may mark it seen. A nonexistent request or a
 *  non-member is a silent no-op — this avoids an FK crash AND closes the enumeration oracle
 *  (get/seen behave identically for "foreign-group request" and "never existed"). */
export async function markSeen(db: AppDb, accountId: string, requestId: string, now: number = Date.now()): Promise<void> {
  const gate = await loadForMember(db, accountId, requestId);
  if (gate.kind !== "ok") return;
  await db.insert(reviewSeen).values({ accountId, requestId, lastSeenAtMs: now })
    .onConflictDoUpdate({ target: [reviewSeen.accountId, reviewSeen.requestId], set: { lastSeenAtMs: now } });
}

export interface ReviewMessageRow { id: string; authorAccountId: string; authorLogin: string | null; body: string; createdAtMs: number }

// Its OWN shape (does NOT extend ReviewRequestSummary): the detail view has no groupName/unread/
// messageCount to fill — those are inbox-only. Carrying them here would force stub values, so we
// don't (explicit over clever).
export interface ReviewRequestDetail {
  id: string; groupId: string; gemKey: string; version: string;
  authorAccountId: string; authorLogin: string | null; status: ReviewStatus;
  description: string | null; createdAtMs: number; resolvedAtMs: number | null;
  manifest: CatalogManifest; archiveDigest: string; messages: ReviewMessageRow[];
}

export type MessageResult = { ok: true; messageId: string } | { ok: false; rejected: "not-found" | "not-a-member" };

// Every request column EXCEPT archive_bytes. loadForMember uses this so the two hot read paths
// (detail view, comment post) never pull the multi-MB archive into memory (D4). Bytes are fetched
// separately, only where actually needed (getReviewArchive, approveReviewRequest).
const REQ_COLS = {
  id: reviewRequests.id, groupId: reviewRequests.groupId, gemKey: reviewRequests.gemKey,
  version: reviewRequests.version, authorAccountId: reviewRequests.authorAccountId,
  status: reviewRequests.status, description: reviewRequests.description,
  manifest: reviewRequests.manifest, archiveDigest: reviewRequests.archiveDigest,
  createdAtMs: reviewRequests.createdAtMs, resolvedAtMs: reviewRequests.resolvedAtMs,
} as const;

/** Load the request (WITHOUT archive bytes) and confirm the viewer is a member of its group.
 *  Returns the bytes-free row, or a reason. Shared by every membership-gated read/write below. */
async function loadForMember(db: AppDb, accountId: string, requestId: string) {
  const row = (await db.select(REQ_COLS).from(reviewRequests).where(eq(reviewRequests.id, requestId)).limit(1))[0];
  if (!row) return { kind: "not-found" as const };
  if ((await groupMemberRole(db, row.groupId, accountId)) === null) return { kind: "not-a-member" as const };
  return { kind: "ok" as const, row };
}

/** Full request detail (manifest + messages, no archive bytes) for a group member. Non-members and
 *  unknown ids both come back null — collapsing "not found" and "not a member" so a caller can't
 *  use this as an enumeration oracle to probe which request ids exist. */
export async function getReviewRequest(db: AppDb, accountId: string, requestId: string): Promise<ReviewRequestDetail | null> {
  const r = await loadForMember(db, accountId, requestId);
  if (r.kind !== "ok") return null;
  const row = r.row;
  const author = (await db.select({ login: accounts.login }).from(accounts).where(eq(accounts.id, row.authorAccountId)).limit(1))[0];
  const msgs = await db.execute(sql`
    select m.id, m.author_account_id, m.body, m.created_at_ms, a.login as author_login
    from review_messages m join accounts a on a.id = m.author_account_id
    where m.request_id = ${requestId} order by m.created_at_ms asc`);
  return {
    id: row.id, groupId: row.groupId, gemKey: row.gemKey, version: row.version,
    authorAccountId: row.authorAccountId, authorLogin: author?.login ?? null, status: row.status,
    description: row.description ?? null, createdAtMs: Number(row.createdAtMs),
    resolvedAtMs: row.resolvedAtMs == null ? null : Number(row.resolvedAtMs),
    manifest: row.manifest as unknown as CatalogManifest, archiveDigest: row.archiveDigest,
    messages: (msgs.rows as any[]).map((m) => ({ id: m.id, authorAccountId: m.author_account_id, authorLogin: m.author_login ?? null, body: m.body, createdAtMs: Number(m.created_at_ms) })),
  };
}

/** The staged .gem bytes for a group member, fetched in a query separate from `loadForMember` so
 *  the multi-MB payload is only ever read when a caller actually needs it. */
export async function getReviewArchive(db: AppDb, accountId: string, requestId: string): Promise<{ bytes: Uint8Array; digest: string } | null> {
  const r = await loadForMember(db, accountId, requestId);
  if (r.kind !== "ok") return null;
  // Membership confirmed on the bytes-free row; NOW fetch the bytes in a targeted query.
  const a = (await db.select({ bytes: reviewRequests.archiveBytes, digest: reviewRequests.archiveDigest })
    .from(reviewRequests).where(eq(reviewRequests.id, requestId)).limit(1))[0];
  return a && a.bytes != null ? { bytes: a.bytes, digest: a.digest } : null;
}

export async function addReviewMessage(db: AppDb, args: { accountId: string; requestId: string; body: string }, now: number = Date.now()): Promise<MessageResult> {
  const r = await loadForMember(db, args.accountId, args.requestId);
  if (r.kind === "not-found") return { ok: false, rejected: "not-found" };
  if (r.kind === "not-a-member") return { ok: false, rejected: "not-a-member" };
  // Gated on membership only, NOT status: commenting on an already-approved/withdrawn request is
  // allowed (post-hoc discussion / an audit trail).
  const id = randomUUID();
  await db.insert(reviewMessages).values({ id, requestId: args.requestId, authorAccountId: args.accountId, body: args.body, createdAtMs: now });
  return { ok: true, messageId: id };
}

export type ApproveResult =
  | { ok: true; gemKey: string; version: string }
  | { ok: false; rejected: "not-found" | "not-a-member" | "self-approval" | "not-open" | "not-scope-owner" | "conflict" };

/** The crux of the review flow: approve `requestId` on behalf of `accountId` and, iff every guard
 *  passes, PUBLISH it (catalog_gems + gem_archives) atomically with the open->approved claim.
 *
 *  Guard order matters:
 *    1. membership + not-found (loadForMember)              -- read, before the tx
 *    2. not the author (no self-approval)                   -- read, before the tx
 *    3. status === "open"                                   -- read, before the tx (fails fast)
 *    4. the AUTHOR still owns the gem's scope (D2 re-check)  -- read, before the tx
 *    5. no catalog owner-conflict for (gemKey, version)      -- read, INSIDE the tx
 *    6. atomic open->approved claim (conditional UPDATE)     -- write, INSIDE the tx
 *    7. publish: upsertCatalogGem + upsertGemArchive         -- write, INSIDE the tx
 *  Steps 5-7 share one `db.transaction` (D5): if the claim loses the race, or the conflict guard
 *  fires, the function returns from inside the transaction callback WITHOUT having written
 *  anything, so nothing to roll back and the request is left `open`. If a write after the claim
 *  were to fail, the transaction rolls the claim back too — a catalog row never appears without
 *  its archive, and a "claimed" request is never left stuck.
 */
export async function approveReviewRequest(db: AppDb, args: { accountId: string; requestId: string }, now: number = Date.now()): Promise<ApproveResult> {
  const load = await loadForMember(db, args.accountId, args.requestId);
  if (load.kind === "not-found") return { ok: false, rejected: "not-found" };
  if (load.kind === "not-a-member") return { ok: false, rejected: "not-a-member" };
  const row = load.row;
  if (row.authorAccountId === args.accountId) return { ok: false, rejected: "self-approval" };
  if (row.status !== "open") return { ok: false, rejected: "not-open" };

  // Re-apply the AUTHOR's scope ownership AT APPROVAL (D2): the author is the publisher, and they may
  // have lost the scope (left the org) since submitting. Publish is a different code path than submit,
  // so the submit-time check must not be trusted here.
  if (!(await accountOwnsScope(db, row.authorAccountId, gemScope(row.gemKey)))) return { ok: false, rejected: "not-scope-owner" };

  // The owner-conflict re-check + atomic claim + BOTH publish writes run in ONE transaction, so a
  // mid-publish failure rolls the claim back — we never leave a catalog row without its archive, nor a
  // claimed request with no publish (D5). upsertCatalogGem/upsertGemArchive accept the tx handle
  // (PgTransaction is assignable to AppDb). A clean early return commits (only harmless reads / a
  // 0-row update happened), so conflict/not-open still leave the request `open`.
  return await db.transaction(async (tx): Promise<ApproveResult> => {
    // Owner-conflict guard INSIDE the tx: an intervening publish of the same key/version by another
    // account must not be overwritten, and the check must be consistent with our own write.
    const existing = (await tx.select({ ownerAccountId: catalogGems.ownerAccountId }).from(catalogGems)
      .where(and(eq(catalogGems.gemKey, row.gemKey), eq(catalogGems.version, row.version))).limit(1))[0];
    if (existing && existing.ownerAccountId !== row.authorAccountId) return { ok: false, rejected: "conflict" };

    // Fetch bytes BEFORE the claim (which nulls the column); loadForMember excludes them for perf (D4).
    const bytesRow = (await tx.select({ bytes: reviewRequests.archiveBytes }).from(reviewRequests)
      .where(eq(reviewRequests.id, args.requestId)).limit(1))[0];

    // Atomic claim: only the row still `open` flips. A concurrent approve/withdraw updates 0 rows -> not-open.
    const claimed = await tx.update(reviewRequests)
      .set({ status: "approved", resolvedAtMs: now, archiveBytes: null })
      .where(and(eq(reviewRequests.id, args.requestId), eq(reviewRequests.status, "open")))
      .returning({ id: reviewRequests.id });
    if (claimed.length === 0) return { ok: false, rejected: "not-open" };

    // Publish through the normal functions. publishedBy/owner are the AUTHOR's, never the approver's.
    const authorLogin = (await tx.select({ login: accounts.login }).from(accounts).where(eq(accounts.id, row.authorAccountId)).limit(1))[0]?.login ?? row.authorAccountId;
    const m = row.manifest as unknown as CatalogManifest;
    await upsertCatalogGem(tx, {
      gemKey: row.gemKey, version: row.version, publishedBy: authorLogin, ownerAccountId: row.authorAccountId,
      author: m.author, description: m.description ?? row.description ?? undefined, tags: m.tags,
      artifactKinds: m.artifactKinds, type: m.type, grade: clampGrade(m.grade), artifacts: m.artifacts, createdAtMs: now,
    });
    if (bytesRow?.bytes != null) {
      await upsertGemArchive(tx, { gemKey: row.gemKey, version: row.version, bytes: bytesRow.bytes, digest: row.archiveDigest, createdAtMs: now, ownerAccountId: row.authorAccountId });
    }
    return { ok: true, gemKey: row.gemKey, version: row.version };
  });
}

export type ChangesResult = { ok: true } | { ok: false; rejected: "not-found" | "not-a-member" | "self" | "not-open" };

/** A member (not the author) sends `requestId` back for changes: atomic `open -> changes-requested`.
 *  The atomic claim (conditional UPDATE) means a concurrent approve/withdraw/request-changes leaves
 *  this a no-op `not-open`, same pattern as approveReviewRequest. */
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

/** The AUTHOR resubmits new bytes/manifest: atomic `changes-requested -> open`. Clears every
 *  review_seen marker for the request so each reviewer's inbox badge goes unread again — the old
 *  markers point at a version nobody has actually reviewed.
 *
 *  Status is checked BEFORE authorship: a non-author calling this on a request that isn't in
 *  `changes-requested` gets `not-changes-requested`, not `forbidden` — the caller learns the
 *  request isn't in a resubmittable state at all, which is the more useful signal when both are
 *  true. `forbidden` is reserved for a non-author hitting a request that IS `changes-requested`. */
export async function resubmitReviewRequest(
  db: AppDb,
  args: { accountId: string; requestId: string; manifest: CatalogManifest; archiveBytes: Uint8Array; archiveDigest: string; description?: string },
  now: number = Date.now(),
): Promise<ResubmitResult> {
  const row = (await db.select({ authorAccountId: reviewRequests.authorAccountId, description: reviewRequests.description, status: reviewRequests.status })
    .from(reviewRequests).where(eq(reviewRequests.id, args.requestId)).limit(1))[0];
  if (!row) return { ok: false, rejected: "not-found" };
  if (row.status !== "changes-requested") return { ok: false, rejected: "not-changes-requested" };
  if (row.authorAccountId !== args.accountId) return { ok: false, rejected: "forbidden" };
  // Claim + seen-marker clear share one transaction (D5): a crash between the two writes must not
  // leave stale review_seen markers pointing at a version nobody has actually reviewed.
  return await db.transaction(async (tx): Promise<ResubmitResult> => {
    const claimed = await tx.update(reviewRequests)
      .set({
        status: "open", resolvedAtMs: null,
        manifest: args.manifest as unknown as Record<string, unknown>,
        archiveBytes: args.archiveBytes, archiveDigest: args.archiveDigest,
        description: args.description ?? row.description ?? null,
      })
      .where(and(eq(reviewRequests.id, args.requestId), eq(reviewRequests.status, "changes-requested")))
      .returning({ id: reviewRequests.id });
    if (claimed.length === 0) return { ok: false, rejected: "not-changes-requested" };
    await tx.delete(reviewSeen).where(eq(reviewSeen.requestId, args.requestId)); // everyone's badge unread again
    return { ok: true };
  });
}

export type WithdrawResult = { ok: true } | { ok: false; rejected: "not-found" | "forbidden" | "not-open" };

/** The AUTHOR withdraws an open request: atomic `open -> withdrawn`, bytes cleared, row kept for
 *  history (same "clear bytes, keep row" shape as approval's claim). Status is checked before
 *  authorship, matching resubmit's ordering (see its comment): `not-open` beats `forbidden` when a
 *  non-author hits a request that's already left the `open` state. */
export async function withdrawReviewRequest(db: AppDb, args: { accountId: string; requestId: string }, now: number = Date.now()): Promise<WithdrawResult> {
  const row = (await db.select({ authorAccountId: reviewRequests.authorAccountId, status: reviewRequests.status })
    .from(reviewRequests).where(eq(reviewRequests.id, args.requestId)).limit(1))[0];
  if (!row) return { ok: false, rejected: "not-found" };
  if (row.status !== "open") return { ok: false, rejected: "not-open" };
  if (row.authorAccountId !== args.accountId) return { ok: false, rejected: "forbidden" };
  const claimed = await db.update(reviewRequests)
    .set({ status: "withdrawn", resolvedAtMs: now, archiveBytes: null })
    .where(and(eq(reviewRequests.id, args.requestId), eq(reviewRequests.status, "open")))
    .returning({ id: reviewRequests.id });
  return claimed.length ? { ok: true } : { ok: false, rejected: "not-open" };
}

/** Withdraws every open/changes-requested request `accountId` authored in `groupId` (status ->
 *  `withdrawn`, bytes cleared) — called by removeMemberGuarded on the successful-removal path so a
 *  departed author leaves no live staging gem behind. Idempotent: re-running after the requests are
 *  already withdrawn matches zero rows and returns { withdrawn: 0 }. */
export async function withdrawRequestsForDepartedMember(db: AppDb, groupId: string, accountId: string, now: number = Date.now()): Promise<{ withdrawn: number }> {
  const res = await db.update(reviewRequests)
    .set({ status: "withdrawn", resolvedAtMs: now, archiveBytes: null })
    .where(and(eq(reviewRequests.groupId, groupId), eq(reviewRequests.authorAccountId, accountId), inArray(reviewRequests.status, ["open", "changes-requested"])))
    .returning({ id: reviewRequests.id });
  return { withdrawn: res.length };
}
