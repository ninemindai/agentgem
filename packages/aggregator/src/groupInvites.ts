// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Group invite links.
//
//   admin mints ──► ACTIVE ──redeem (multi-use)──► via_invite grant
//                     │ │
//                     │ └── expires_at passes ───► GONE (410)
//                     └──── admin revokes BY ID ─► GONE (410)
//
// `id` is the public handle: it is what an admin sees and what revoke takes. Only sha256(token)
// is persisted, so a DB leak cannot join a group — and revocation never needs the raw token back,
// which means the token never has to travel in a URL, a log, or a Referer header.
//
// Deliberately NOT delete-on-read like handoff_codes: a handoff code is a machine-to-machine
// one-shot; an invite is a link pasted into a chat and clicked by several people.
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { and, eq, isNull, lt } from "drizzle-orm";
import type { AppDb } from "./schema.js";
import { groupInvites } from "./schema.js";
import { grantInvite, type GroupRole } from "./groups.js";

const sha256hex = (s: string): string => createHash("sha256").update(s).digest("hex");

/** "gone" covers expired AND revoked: to the person clicking the link they are the same story,
 *  and the token is high-entropy, so there is no enumeration oracle to protect. */
export type RedeemResult = "ok" | "not-found" | "gone";
export interface InviteSummary { id: string; role: GroupRole; expiresAt: Date; revokedAt: Date | null }

export async function createGroupInvite(
  db: AppDb, opts: { groupId: string; role: GroupRole; createdBy: string; ttlMs: number },
): Promise<{ id: string; token: string; expiresAt: string }> {
  const id = randomUUID();
  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + opts.ttlMs);
  await db.insert(groupInvites).values({
    id, tokenHash: sha256hex(token), groupId: opts.groupId, role: opts.role, createdBy: opts.createdBy, expiresAt,
  });
  return { id, token, expiresAt: expiresAt.toISOString() };
}

/** Join the invite's group with a via_invite grant. Multi-use: the row survives redemption.
 *  Opportunistically sweeps invites that expired over a day ago so the table cannot grow unbounded. */
export async function redeemGroupInvite(
  db: AppDb, token: string, accountId: string, now: number = Date.now(),
): Promise<RedeemResult> {
  const rows = await db
    .select({ groupId: groupInvites.groupId, role: groupInvites.role, expiresAt: groupInvites.expiresAt, revokedAt: groupInvites.revokedAt })
    .from(groupInvites)
    .where(eq(groupInvites.tokenHash, sha256hex(token)))
    .limit(1);
  const row = rows[0];
  if (!row) return "not-found";
  if (row.revokedAt || new Date(row.expiresAt).getTime() <= now) return "gone";
  await grantInvite(db, row.groupId, accountId, row.role as GroupRole);
  await db.delete(groupInvites).where(lt(groupInvites.expiresAt, new Date(now - 86_400_000)));
  return "ok";
}

/** Revoke by id, scoped to the group the caller administers. An id from another group is refused,
 *  so an admin of group A cannot revoke group B's invites by guessing a uuid. Returns false when
 *  nothing was revoked (unknown id, wrong group, or already revoked). */
export async function revokeGroupInvite(
  db: AppDb, groupId: string, inviteId: string, now: number = Date.now(),
): Promise<boolean> {
  const rows = await db
    .update(groupInvites)
    .set({ revokedAt: new Date(now) })
    .where(and(eq(groupInvites.id, inviteId), eq(groupInvites.groupId, groupId), isNull(groupInvites.revokedAt)))
    .returning({ id: groupInvites.id });
  return rows.length > 0;
}

/** Outstanding invites for an admin UI. Returns ids, never token_hash — the hash is useless to a
 *  caller and its presence in a JSON response invites someone to try using it as a token. */
export async function listGroupInvites(db: AppDb, groupId: string): Promise<InviteSummary[]> {
  const rows = await db
    .select({ id: groupInvites.id, role: groupInvites.role, expiresAt: groupInvites.expiresAt, revokedAt: groupInvites.revokedAt })
    .from(groupInvites)
    .where(eq(groupInvites.groupId, groupId));
  return rows.map((r) => ({ ...r, role: r.role as GroupRole }));
}
