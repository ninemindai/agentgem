// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Team usage: self-reported daily rollups (recordUsageDays) and the org-internal dashboard
// aggregation (buildOrgUsage). Membership boundary = account_scopes, the same GitHub-org capture
// the org catalog uses; the caller (src/usage/install.ts) enforces accountOwnsScope before reading.
import { and, eq, gte, sql } from "drizzle-orm";
import type { AppDb } from "./schema.js";
import { usageDays, accounts, accountScopes } from "./schema.js";

/** One UTC day of local agent usage in one repo-owner scope, as scanned from the machine's
 *  transcripts. `scope` = lowercased owner of the repo the sessions ran in ("" = unattributed) —
 *  the client-side attribution that keeps an org's dashboard free of other scopes' work. */
export interface UsageDayReport {
  scope: string;
  date: string; // "YYYY-MM-DD" (UTC)
  sessions: number;
  msgs: number;
  tokensIn: number;
  tokensOut: number;
  tokensCache: number;
  activeMs: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS_PER_REPORT = 400;
const MAX_MACHINE_LEN = 64;
const MAX_SCOPE_LEN = 100;

// Clamp to a safe non-negative integer; garbage (NaN, negatives, floats) becomes 0/floor rather
// than a rejected report — a partial rollup is more useful than none for a dashboard.
const clamp = (n: unknown): number => {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : 0;
  return v > 0 ? Math.min(v, Number.MAX_SAFE_INTEGER) : 0;
};

/** Validate + normalize a reported batch. Returns null when the envelope is unusable. */
export function normalizeUsageReport(body: { machine?: unknown; days?: unknown }): { machine: string; days: UsageDayReport[] } | null {
  const machine = typeof body.machine === "string" && body.machine.trim().length > 0 ? body.machine.trim().slice(0, MAX_MACHINE_LEN) : "default";
  if (!Array.isArray(body.days) || body.days.length === 0 || body.days.length > MAX_DAYS_PER_REPORT) return null;
  const days: UsageDayReport[] = [];
  for (const raw of body.days as Array<Record<string, unknown>>) {
    if (typeof raw !== "object" || raw === null) return null;
    const date = String(raw.date ?? "");
    if (!DATE_RE.test(date)) return null;
    const scope = typeof raw.scope === "string" ? raw.scope.trim().toLowerCase().slice(0, MAX_SCOPE_LEN) : "";
    days.push({
      scope,
      date,
      sessions: clamp(raw.sessions),
      msgs: clamp(raw.msgs),
      tokensIn: clamp(raw.tokensIn),
      tokensOut: clamp(raw.tokensOut),
      tokensCache: clamp(raw.tokensCache),
      activeMs: clamp(raw.activeMs),
    });
  }
  return { machine, days };
}

/** Upsert a batch of daily rollups for (account, machine, scope). Re-reports overwrite: the local
 *  scan is the source of truth for that machine's day, so the freshest report wins. */
export async function recordUsageDays(db: AppDb, accountId: string, machine: string, days: UsageDayReport[]): Promise<{ recorded: number }> {
  for (const d of days) {
    await db
      .insert(usageDays)
      .values({ accountId, machine, scope: d.scope ?? "", date: d.date, sessions: d.sessions, msgs: d.msgs, tokensIn: d.tokensIn, tokensOut: d.tokensOut, tokensCache: d.tokensCache, activeMs: d.activeMs })
      .onConflictDoUpdate({
        target: [usageDays.accountId, usageDays.machine, usageDays.scope, usageDays.date],
        set: { sessions: d.sessions, msgs: d.msgs, tokensIn: d.tokensIn, tokensOut: d.tokensOut, tokensCache: d.tokensCache, activeMs: d.activeMs, reportedAt: new Date() },
      });
  }
  return { recorded: days.length };
}

export type OrgUsageRange = "7d" | "30d" | "all";

export interface OrgUsageMember {
  login: string;
  avatarUrl: string | null;
  sessions: number;
  msgs: number;
  tokensIn: number;
  tokensOut: number;
  tokensCache: number;
  tokens: number; // in + out + cache — the leaderboard headline number
  activeMs: number;
  activeDays: number;
  lastActive: string | null; // latest reported date within range
}

export interface OrgUsageDay { date: string; sessions: number; tokens: number }

export interface OrgUsage {
  scope: string;
  range: OrgUsageRange;
  memberCount: number; // scope members with any usage in range
  totals: { sessions: number; msgs: number; tokensIn: number; tokensOut: number; tokensCache: number; tokens: number; activeMs: number; activeDays: number };
  members: OrgUsageMember[];
  daily: OrgUsageDay[]; // org-wide series, ascending by date (heatmap + trend)
}

export const RANGE_DAYS: Record<OrgUsageRange, number | null> = { "7d": 7, "30d": 30, all: null };

/** The inclusive "YYYY-MM-DD" UTC cutoff for a range, or null for all-time. */
export function rangeCutoff(range: OrgUsageRange, nowMs: number): string | null {
  const days = RANGE_DAYS[range];
  if (days === null) return null;
  return new Date(nowMs - (days - 1) * 86_400_000).toISOString().slice(0, 10);
}

/** Aggregate the org's usage: per-member leaderboard rows + org totals + org-wide daily series.
 *  Members = accounts whose captured scopes include `scope` AND that reported usage in range.
 *  Anti-leak: only rows ATTRIBUTED to this scope count (usage_days.scope, from the reporter's
 *  repo-owner detection) — a member's personal or other-org work never shows here. The personal
 *  view (scope = caller's own login) also folds in unattributed ("") rows via includeUnattributed. */
export async function buildOrgUsage(db: AppDb, scope: string, range: OrgUsageRange, nowMs: number = Date.now(), opts: { includeUnattributed?: boolean } = {}): Promise<OrgUsage> {
  const cutoff = rangeCutoff(range, nowMs);
  const inRange = cutoff === null ? undefined : gte(usageDays.date, cutoff);
  const scopeLc = scope.toLowerCase();
  const attributed = opts.includeUnattributed
    ? sql`${usageDays.scope} in (${scopeLc}, '')`
    : eq(usageDays.scope, scopeLc);
  const memberFilter = and(eq(accountScopes.scope, scope), attributed, ...(inRange ? [inRange] : []));

  const memberRows = await db
    .select({
      login: accounts.login,
      avatarUrl: accounts.avatarUrl,
      sessions: sql<number>`sum(${usageDays.sessions})::int`,
      msgs: sql<number>`sum(${usageDays.msgs})::int`,
      tokensIn: sql<number>`sum(${usageDays.tokensIn})::bigint`,
      tokensOut: sql<number>`sum(${usageDays.tokensOut})::bigint`,
      tokensCache: sql<number>`sum(${usageDays.tokensCache})::bigint`,
      activeMs: sql<number>`sum(${usageDays.activeMs})::bigint`,
      activeDays: sql<number>`count(distinct ${usageDays.date})::int`,
      lastActive: sql<string | null>`max(${usageDays.date})`,
    })
    .from(usageDays)
    .innerJoin(accounts, eq(usageDays.accountId, accounts.id))
    .innerJoin(accountScopes, eq(accountScopes.accountId, accounts.id))
    .where(memberFilter)
    .groupBy(accounts.id, accounts.login, accounts.avatarUrl);

  // pglite/pg drivers return bigint sums as strings — coerce every aggregate to number.
  const members: OrgUsageMember[] = memberRows
    .map((r) => {
      const tokensIn = Number(r.tokensIn ?? 0), tokensOut = Number(r.tokensOut ?? 0), tokensCache = Number(r.tokensCache ?? 0);
      return {
        login: r.login,
        avatarUrl: r.avatarUrl,
        sessions: Number(r.sessions ?? 0),
        msgs: Number(r.msgs ?? 0),
        tokensIn, tokensOut, tokensCache,
        tokens: tokensIn + tokensOut + tokensCache,
        activeMs: Number(r.activeMs ?? 0),
        activeDays: Number(r.activeDays ?? 0),
        lastActive: r.lastActive ?? null,
      };
    })
    .sort((a, b) => b.tokens - a.tokens || a.login.localeCompare(b.login));

  const dailyRows = await db
    .select({
      date: usageDays.date,
      sessions: sql<number>`sum(${usageDays.sessions})::int`,
      tokens: sql<number>`(sum(${usageDays.tokensIn}) + sum(${usageDays.tokensOut}) + sum(${usageDays.tokensCache}))::bigint`,
    })
    .from(usageDays)
    .innerJoin(accountScopes, eq(accountScopes.accountId, usageDays.accountId))
    .where(memberFilter)
    .groupBy(usageDays.date)
    .orderBy(usageDays.date);

  const daily: OrgUsageDay[] = dailyRows.map((r) => ({ date: r.date, sessions: Number(r.sessions ?? 0), tokens: Number(r.tokens ?? 0) }));

  const totals = members.reduce(
    (t, m) => ({
      sessions: t.sessions + m.sessions, msgs: t.msgs + m.msgs,
      tokensIn: t.tokensIn + m.tokensIn, tokensOut: t.tokensOut + m.tokensOut, tokensCache: t.tokensCache + m.tokensCache,
      tokens: t.tokens + m.tokens, activeMs: t.activeMs + m.activeMs, activeDays: t.activeDays,
    }),
    { sessions: 0, msgs: 0, tokensIn: 0, tokensOut: 0, tokensCache: 0, tokens: 0, activeMs: 0, activeDays: daily.length },
  );

  return { scope, range, memberCount: members.length, totals, members, daily };
}
