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
import { reviewRequests, reviewSeen, type ReviewStatus } from "./schema.js";
import { groupMemberRole, listGroupsForAccount } from "./groups.js";
import { accountOwnsScope } from "./webAuth.js";
import { catalogGemExists, type CatalogManifest } from "./catalog.js";

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

/** Marks `requestId` as seen by `accountId` at `now`, upserting the review_seen marker. */
export async function markSeen(db: AppDb, accountId: string, requestId: string, now: number = Date.now()): Promise<void> {
  await db.insert(reviewSeen).values({ accountId, requestId, lastSeenAtMs: now })
    .onConflictDoUpdate({ target: [reviewSeen.accountId, reviewSeen.requestId], set: { lastSeenAtMs: now } });
}
