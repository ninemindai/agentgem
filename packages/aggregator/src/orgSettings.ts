// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Org dashboard settings — the first admin-gated write surface (account_scopes.role = "admin",
// captured from GitHub at sign-in/bind). v1 knob: usage retention. The caller (src/usage/install.ts)
// enforces the admin gate; this module is pure storage + the retention prune.
import { and, eq, inArray, lt } from "drizzle-orm";
import type { AppDb } from "./schema.js";
import { orgSettings, usageDays, usageDayModels, accountScopes } from "./schema.js";

export interface OrgSettings { scope: string; retentionDays: number | null; dashboardEnabled: boolean; updatedBy: string | null; updatedAt: string | null }

const MIN_RETENTION_DAYS = 7;
const MAX_RETENTION_DAYS = 730;

/** Current settings for an org; defaults (retention: keep forever, dashboard on) when never configured. */
export async function getOrgSettings(db: AppDb, scope: string): Promise<OrgSettings> {
  const rows = await db.select().from(orgSettings).where(eq(orgSettings.scope, scope.toLowerCase())).limit(1);
  const r = rows[0];
  if (!r) return { scope: scope.toLowerCase(), retentionDays: null, dashboardEnabled: true, updatedBy: null, updatedAt: null };
  return { scope: r.scope, retentionDays: r.retentionDays ?? null, dashboardEnabled: r.dashboardEnabled, updatedBy: r.updatedBy, updatedAt: r.updatedAt.toISOString() };
}

/** Validate a retention value: null = keep forever; otherwise clamp into [7, 730] whole days. */
export function normalizeRetentionDays(v: unknown): number | null | undefined {
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  const days = Math.floor(v);
  return days >= MIN_RETENTION_DAYS && days <= MAX_RETENTION_DAYS ? days : undefined;
}

/** Upsert an org's settings (admin-gated by the caller) and apply retention immediately. */
export async function putOrgSettings(db: AppDb, scope: string, values: { retentionDays: number | null; dashboardEnabled: boolean }, updatedBy: string, nowMs: number = Date.now()): Promise<OrgSettings> {
  const scopeLc = scope.toLowerCase();
  const { retentionDays, dashboardEnabled } = values;
  await db
    .insert(orgSettings)
    .values({ scope: scopeLc, retentionDays, dashboardEnabled, updatedBy })
    .onConflictDoUpdate({ target: [orgSettings.scope], set: { retentionDays, dashboardEnabled, updatedBy, updatedAt: new Date(nowMs) } });
  await applyRetention(db, scopeLc, retentionDays, nowMs);
  return getOrgSettings(db, scopeLc);
}

/** Delete this org's usage rows older than the retention window. No-op for null (keep forever).
 *  Scope-bounded on purpose: retention is an ORG policy, so it must never touch rows attributed
 *  to other scopes (or unattributed personal rows). */
export async function applyRetention(db: AppDb, scope: string, retentionDays: number | null, nowMs: number = Date.now()): Promise<void> {
  if (retentionDays === null) return;
  const cutoff = new Date(nowMs - retentionDays * 86_400_000).toISOString().slice(0, 10);
  const scopeLc = scope.toLowerCase();
  await db.delete(usageDays).where(and(eq(usageDays.scope, scopeLc), lt(usageDays.date, cutoff)));
  await db.delete(usageDayModels).where(and(eq(usageDayModels.scope, scopeLc), lt(usageDayModels.date, cutoff)));
}

/** Apply every configured org's retention to a reporter's freshly-written scopes (post-ingest
 *  hook): one query for the settings of exactly the scopes in the report, then scope-bounded
 *  prunes. Keeps retention enforced without a background job. */
export async function applyRetentionForScopes(db: AppDb, scopes: string[], nowMs: number = Date.now()): Promise<void> {
  const unique = [...new Set(scopes.map((s) => s.toLowerCase()).filter((s) => s.length > 0))];
  if (unique.length === 0) return;
  const rows = await db
    .select({ scope: orgSettings.scope, retentionDays: orgSettings.retentionDays })
    .from(orgSettings)
    .where(inArray(orgSettings.scope, unique));
  for (const r of rows) {
    if (typeof r.retentionDays === "number") await applyRetention(db, r.scope, r.retentionDays, nowMs);
  }
}

/** The caller's role for a scope ("self" | "admin" | "member") or null when not a member. */
export async function accountScopeRole(db: AppDb, accountId: string, scope: string): Promise<string | null> {
  const rows = await db
    .select({ role: accountScopes.role })
    .from(accountScopes)
    .where(and(eq(accountScopes.accountId, accountId), eq(accountScopes.scope, scope)))
    .limit(1);
  return rows[0]?.role ?? null;
}
