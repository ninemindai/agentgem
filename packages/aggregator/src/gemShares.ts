// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// gem_group_shares store: the additive ACL that gives native groups a payload. Sharing keys on
// gem_key (the app identity) — every private version of the gem inherits the share. Access is
// decided by accountCanAccessGem, the single gate every private-serving reader routes through.
import { and, desc, eq, sql } from "drizzle-orm";
import type { AppDb } from "./schema.js";
import { gemGroupShares, groups, catalogGems, gemArchives } from "./schema.js";
import { gemAccessInfo } from "./catalog.js";

/** Share a gem (by key) with a group. Idempotent — re-sharing is a no-op. */
export async function shareGemWithGroup(
  db: AppDb, gemKey: string, groupId: string, createdBy: string, now: number = Date.now(),
): Promise<void> {
  await db.insert(gemGroupShares)
    .values({ gemKey, groupId, createdBy, createdAtMs: now })
    .onConflictDoNothing();
}

/** Remove a share. True iff a row was actually removed. */
export async function unshareGemFromGroup(db: AppDb, gemKey: string, groupId: string): Promise<boolean> {
  const removed = await db.delete(gemGroupShares)
    .where(and(eq(gemGroupShares.gemKey, gemKey), eq(gemGroupShares.groupId, groupId)))
    .returning({ groupId: gemGroupShares.groupId });
  return removed.length > 0;
}

/** Groups a gem is shared with, with names — for the owner's share panel. */
export async function listGroupsForGem(db: AppDb, gemKey: string): Promise<{ groupId: string; name: string }[]> {
  const rows = await db.select({ groupId: gemGroupShares.groupId, name: groups.name })
    .from(gemGroupShares)
    .innerJoin(groups, eq(gemGroupShares.groupId, groups.id))
    .where(eq(gemGroupShares.gemKey, gemKey));
  return rows.map((r) => ({ groupId: r.groupId, name: r.name }));
}

/** The single access gate. Public/unlisted (or no catalog row) → anyone. Private → owner, or a
 *  member of any group the gem is shared with. A null accountId (signed out) never clears private. */
export async function accountCanAccessGem(
  db: AppDb, gemKey: string, version: string, accountId: string | null,
): Promise<boolean> {
  const info = await gemAccessInfo(db, gemKey, version);
  if (!info) return true;                          // no catalog row: unlisted archive / unknown — not private
  if (info.visibility !== "private") return true;  // public + unlisted stay open
  if (!accountId) return false;
  if (info.ownerAccountId === accountId) return true;
  const shared = (await db.execute(sql`
    select 1 from gem_group_shares s
    join group_members m on m.group_id = s.group_id
    where s.gem_key = ${gemKey} and m.account_id = ${accountId}
    limit 1`)).rows;
  return shared.length > 0;
}

/** Gems shared with a group, each at its latest published version, with the metadata the
 *  marketplace's discovery listing needs. Newest-shared first. */
export async function listGemsSharedWithGroup(
  db: AppDb, groupId: string,
): Promise<{ gemKey: string; version: string; description: string; artifactKinds: string[]; installable: boolean }[]> {
  const shares = await db.select({ gemKey: gemGroupShares.gemKey })
    .from(gemGroupShares).where(eq(gemGroupShares.groupId, groupId));
  const out: { gemKey: string; version: string; description: string; artifactKinds: string[]; installable: boolean }[] = [];
  for (const s of shares) {
    const row = (await db.select({
      version: catalogGems.version, description: catalogGems.description,
      artifactKinds: catalogGems.artifactKinds, archiveKey: gemArchives.gemKey,
    }).from(catalogGems)
      .leftJoin(gemArchives, and(eq(catalogGems.gemKey, gemArchives.gemKey), eq(catalogGems.version, gemArchives.version)))
      .where(eq(catalogGems.gemKey, s.gemKey))
      .orderBy(desc(catalogGems.createdAtMs)).limit(1))[0];
    if (!row) continue;   // share to a gem with no catalog row (fully unpublished) — skip
    out.push({
      gemKey: s.gemKey, version: row.version, description: row.description ?? "",
      artifactKinds: row.artifactKinds ?? [], installable: row.archiveKey != null,
    });
  }
  return out;
}
