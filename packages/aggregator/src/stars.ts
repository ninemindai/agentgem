// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Stars: per-account engagement on gems + ingredients. Generic (kind + text id), no FK to the
// target (gems live in the registry/static catalog, not this DB).
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { AppDb } from "./schema.js";
import { stars } from "./schema.js";

async function countFor(db: AppDb, kind: string, id: string): Promise<number> {
  const r = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from stars where target_kind = ${kind} and target_id = ${id}`,
  );
  return r.rows[0]?.n ?? 0;
}

export async function toggleStar(db: AppDb, accountId: string, kind: string, id: string): Promise<{ starred: boolean; count: number }> {
  const existing = await db
    .select({ id: stars.id })
    .from(stars)
    .where(and(eq(stars.accountId, accountId), eq(stars.targetKind, kind), eq(stars.targetId, id)))
    .limit(1);
  if (existing[0]) {
    await db.delete(stars).where(eq(stars.id, existing[0].id));
    return { starred: false, count: await countFor(db, kind, id) };
  }
  await db.insert(stars).values({ id: randomUUID(), accountId, targetKind: kind, targetId: id });
  return { starred: true, count: await countFor(db, kind, id) };
}

export async function starCounts(db: AppDb, kind: string, ids: string[]): Promise<Record<string, number>> {
  if (ids.length === 0) return {};
  const rows = await db
    .select({ targetId: stars.targetId, n: sql<number>`count(*)::int` })
    .from(stars)
    .where(and(eq(stars.targetKind, kind), inArray(stars.targetId, ids)))
    .groupBy(stars.targetId);
  const out: Record<string, number> = {};
  for (const row of rows) out[row.targetId] = row.n;
  return out;
}

export async function starredIds(db: AppDb, accountId: string, kind: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ targetId: stars.targetId })
    .from(stars)
    .where(and(eq(stars.accountId, accountId), eq(stars.targetKind, kind), inArray(stars.targetId, ids)));
  return rows.map((x) => x.targetId);
}
