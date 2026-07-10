// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Mini-game play counts. A play is one click into fullscreen on the marketplace arcade — see the
// `gamePlays` table comment for why this can never be a "unique users" number.
import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import type { AppDb } from "./schema.js";
import { gamePlays } from "./schema.js";

// A visitor id is client-supplied and never trusted: it is stored only to check a count against
// distinct browsers, so cap it rather than validate it. Anything longer is junk or an attack.
const VISITOR_ID_MAX = 64;

export async function recordGamePlay(db: AppDb, p: { gemKey: string; version: string; visitorId?: string | null }): Promise<void> {
  const visitorId = p.visitorId ? p.visitorId.slice(0, VISITOR_ID_MAX) : null;
  await db.insert(gamePlays).values({ id: randomUUID(), gemKey: p.gemKey, version: p.version, visitorId });
}

// Plays per gem, summed across the gem's versions (a new version of a game is the same game to a
// reader). Gems with no plays are absent — the caller defaults them to 0. `keys` filters; omit for all.
export async function gamePlayCounts(db: AppDb, opts: { keys?: string[] }): Promise<Array<{ gemKey: string; plays: number }>> {
  if (opts.keys?.length === 0) return [];
  const rows = await db.select({ gemKey: gamePlays.gemKey, plays: sql<number>`count(*)::int` })
    .from(gamePlays)
    .where(opts.keys ? inArray(gamePlays.gemKey, opts.keys) : undefined)
    .groupBy(gamePlays.gemKey);
  return rows;
}
