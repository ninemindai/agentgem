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
