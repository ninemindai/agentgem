// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Reviews: per-account written ratings (1-5 + optional prose) on a target. Generic (kind + text
// id), no FK to the target — like `stars`, but content-bearing, so callers key on the concrete
// catalog skill (kind "skill", id "<sourceId>/<path>") rather than the lossy skill-name id.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { AppDb } from "./schema.js";

export interface Review { rating: number; body: string | null; createdAt: string; updatedAt: string }
export interface ReviewSummary { avg: number; count: number }
export interface ReviewView { login: string; avatarUrl: string | null; rating: number; body: string | null; createdAt: string; updatedAt: string }

// Insert-or-edit the caller's one review for this target. A single `on conflict do update` (NOT
// select-then-insert) so two concurrent first-writes can't collide on the unique index and 500.
export async function upsertReview(
  db: AppDb, accountId: string, kind: string, id: string, rating: number, body: string | null,
): Promise<Review> {
  const r = await db.execute<{ rating: number; body: string | null; createdAt: string; updatedAt: string }>(sql`
    insert into reviews (id, account_id, target_kind, target_id, rating, body)
    values (${randomUUID()}, ${accountId}, ${kind}, ${id}, ${rating}, ${body})
    on conflict (account_id, target_kind, target_id) do update
      set rating = excluded.rating, body = excluded.body, updated_at = now()
    returning rating, body, created_at as "createdAt", updated_at as "updatedAt"
  `);
  return r.rows[0]!;
}

export async function deleteReview(db: AppDb, accountId: string, kind: string, id: string): Promise<void> {
  await db.execute(sql`delete from reviews where account_id = ${accountId} and target_kind = ${kind} and target_id = ${id}`);
}

// avg(rating) is null on zero rows and numeric/string across drivers — coalesce to 0, round to one
// decimal, cast to float so the response type (number) is honest.
export async function reviewSummary(db: AppDb, kind: string, id: string): Promise<ReviewSummary> {
  const r = await db.execute<{ avg: number; count: number }>(sql`
    select coalesce(round(avg(rating)::numeric, 1), 0)::float as avg, count(*)::int as count
    from reviews where target_kind = ${kind} and target_id = ${id}
  `);
  return { avg: r.rows[0]?.avg ?? 0, count: r.rows[0]?.count ?? 0 };
}

// Batch summary for a card grid (mirrors starCounts). Targets with no reviews are simply absent
// from the map — the caller defaults them to nothing.
export async function reviewSummaries(db: AppDb, kind: string, ids: string[]): Promise<Record<string, ReviewSummary>> {
  if (ids.length === 0) return {};
  const list = sql.join(ids.map((i) => sql`${i}`), sql`, `);
  const r = await db.execute<{ targetId: string; avg: number; count: number }>(sql`
    select target_id as "targetId", round(avg(rating)::numeric, 1)::float as avg, count(*)::int as count
    from reviews where target_kind = ${kind} and target_id in (${list})
    group by target_id
  `);
  const out: Record<string, ReviewSummary> = {};
  for (const row of r.rows) out[row.targetId] = { avg: row.avg, count: row.count };
  return out;
}

// Latest N reviews joined to the reviewer's account, newest first. Order is by created_at (a
// review's slot is fixed when first written); updatedAt travels along so the UI can flag edits.
export async function listReviews(db: AppDb, kind: string, id: string, limit = 50): Promise<ReviewView[]> {
  // login can be NULL (Task 3) since the anchor now writes an accounts row for any provider —
  // display falls back to "user".handle then "user".name. Left join: not every accounts row has
  // a same-id "user" row (e.g. bind-only accounts in tests/older data), so an inner join would
  // silently drop the reviewer instead of falling all the way to ''.
  const r = await db.execute<{ login: string; avatarUrl: string | null; rating: number; body: string | null; createdAt: string; updatedAt: string }>(sql`
    select coalesce(a.login, u.handle, u.name, '') as login, a.avatar_url as "avatarUrl", r.rating, r.body,
           r.created_at as "createdAt", r.updated_at as "updatedAt"
    from reviews r join accounts a on a.id = r.account_id left join "user" u on u.id = a.id::text
    where r.target_kind = ${kind} and r.target_id = ${id}
    order by r.created_at desc
    limit ${limit}
  `);
  return r.rows as ReviewView[];
}

// Reviews an account has authored (for their public profile), newest first. Returns the raw
// target_id — the caller parses it into the concrete skill (sourceId/path).
export interface AuthoredReview { targetId: string; rating: number; body: string | null; createdAt: string; updatedAt: string }
export async function reviewsByAccount(db: AppDb, accountId: string, kind: string, limit = 50): Promise<AuthoredReview[]> {
  const r = await db.execute<{ targetId: string; rating: number; body: string | null; createdAt: string; updatedAt: string }>(sql`
    select target_id as "targetId", rating, body, created_at::text as "createdAt", updated_at::text as "updatedAt"
    from reviews where account_id = ${accountId} and target_kind = ${kind}
    order by created_at desc
    limit ${limit}
  `);
  return r.rows as AuthoredReview[];
}

// The caller's own review for this target (so the write form can prefill for editing), or null.
export async function myReview(db: AppDb, accountId: string, kind: string, id: string): Promise<Review | null> {
  const r = await db.execute<{ rating: number; body: string | null; createdAt: string; updatedAt: string }>(sql`
    select rating, body, created_at as "createdAt", updated_at as "updatedAt"
    from reviews where account_id = ${accountId} and target_kind = ${kind} and target_id = ${id}
  `);
  return (r.rows[0] as Review | undefined) ?? null;
}
