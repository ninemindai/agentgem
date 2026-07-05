// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Team usage: self-reported daily rollups (recordUsageDays) and the org-internal dashboard
// aggregation (buildOrgUsage). Membership boundary = account_scopes, the same GitHub-org capture
// the org catalog uses; the caller (src/usage/install.ts) enforces accountOwnsScope before reading.
import { and, eq, gte, sql } from "drizzle-orm";
import type { AppDb } from "./schema.js";
import { usageDays, usageDayModels, accounts, accountScopes } from "./schema.js";

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

/** One (agent, model) slice of a usage day in one scope — the "By Model" breakdown. */
export interface UsageModelReport {
  scope: string;
  date: string;
  agent: string;
  model: string;
  sessions: number;
  tokens: number;
}

const MAX_MODEL_ROWS_PER_REPORT = 2000;
const MAX_NAME_LEN = 100;

/** Validate + normalize the optional per-model rows of a report. Never rejects the whole report:
 *  malformed rows are dropped (the day rollup above is the part that must land). */
export function normalizeUsageModels(models: unknown): UsageModelReport[] {
  if (!Array.isArray(models)) return [];
  const out: UsageModelReport[] = [];
  for (const raw of models.slice(0, MAX_MODEL_ROWS_PER_REPORT) as Array<Record<string, unknown>>) {
    if (typeof raw !== "object" || raw === null) continue;
    const date = String(raw.date ?? "");
    if (!DATE_RE.test(date)) continue;
    out.push({
      scope: typeof raw.scope === "string" ? raw.scope.trim().toLowerCase().slice(0, MAX_SCOPE_LEN) : "",
      date,
      agent: typeof raw.agent === "string" ? raw.agent.trim().slice(0, MAX_NAME_LEN) : "",
      model: typeof raw.model === "string" ? raw.model.trim().slice(0, MAX_NAME_LEN) : "",
      sessions: clamp(raw.sessions),
      tokens: clamp(raw.tokens),
    });
  }
  return out;
}

/** Upsert per-(agent, model) day slices, same overwrite semantics as recordUsageDays. */
export async function recordUsageModels(db: AppDb, accountId: string, machine: string, models: UsageModelReport[]): Promise<{ recorded: number }> {
  for (const m of models) {
    await db
      .insert(usageDayModels)
      .values({ accountId, machine, scope: m.scope ?? "", date: m.date, agent: m.agent, model: m.model, sessions: m.sessions, tokens: m.tokens })
      .onConflictDoUpdate({
        target: [usageDayModels.accountId, usageDayModels.machine, usageDayModels.scope, usageDayModels.date, usageDayModels.agent, usageDayModels.model],
        set: { sessions: m.sessions, tokens: m.tokens, reportedAt: new Date() },
      });
  }
  return { recorded: models.length };
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
export interface OrgUsageModel { agent: string; model: string; sessions: number; tokens: number }
export interface OrgUsageAgent { agent: string; sessions: number; tokens: number }

export interface OrgUsage {
  scope: string;
  range: OrgUsageRange;
  memberCount: number; // scope members with any usage in range
  totals: { sessions: number; msgs: number; tokensIn: number; tokensOut: number; tokensCache: number; tokens: number; activeMs: number; activeDays: number };
  members: OrgUsageMember[];
  daily: OrgUsageDay[]; // org-wide series, ascending by date (heatmap + trend)
  models: OrgUsageModel[]; // top models by tokens within range (same scope boundary)
  agents: OrgUsageAgent[]; // per-agent rollup within range
}

const MODELS_LIMIT = 12;

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
 *  view (scope = caller's own login) also folds in unattributed ("") rows via includeUnattributed.
 *  `memberLogin` narrows everything (member row, daily series, models) to one member — the org
 *  drill-down. It stays INSIDE the org-scope boundary: it is that member's work for this org, not
 *  their personal view. */
export async function buildOrgUsage(db: AppDb, scope: string, range: OrgUsageRange, nowMs: number = Date.now(), opts: { includeUnattributed?: boolean; memberLogin?: string } = {}): Promise<OrgUsage> {
  const cutoff = rangeCutoff(range, nowMs);
  const inRange = cutoff === null ? undefined : gte(usageDays.date, cutoff);
  const scopeLc = scope.toLowerCase();
  const attributed = opts.includeUnattributed
    ? sql`${usageDays.scope} in (${scopeLc}, '')`
    : eq(usageDays.scope, scopeLc);
  const memberOnly = opts.memberLogin ? eq(accounts.login, opts.memberLogin) : undefined;
  const memberFilter = and(eq(accountScopes.scope, scope), attributed, ...(inRange ? [inRange] : []), ...(memberOnly ? [memberOnly] : []));

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
    .innerJoin(accounts, eq(usageDays.accountId, accounts.id))
    .innerJoin(accountScopes, eq(accountScopes.accountId, usageDays.accountId))
    .where(memberFilter)
    .groupBy(usageDays.date)
    .orderBy(usageDays.date);

  const daily: OrgUsageDay[] = dailyRows.map((r) => ({ date: r.date, sessions: Number(r.sessions ?? 0), tokens: Number(r.tokens ?? 0) }));

  // "By model" / "by agent" slices, same membership + scope-attribution + range boundary as above.
  const modelInRange = cutoff === null ? undefined : gte(usageDayModels.date, cutoff);
  const modelAttributed = opts.includeUnattributed
    ? sql`${usageDayModels.scope} in (${scopeLc}, '')`
    : eq(usageDayModels.scope, scopeLc);
  const modelFilter = and(eq(accountScopes.scope, scope), modelAttributed, ...(modelInRange ? [modelInRange] : []), ...(memberOnly ? [memberOnly] : []));
  const modelRows = await db
    .select({
      agent: usageDayModels.agent,
      model: usageDayModels.model,
      sessions: sql<number>`sum(${usageDayModels.sessions})::int`,
      tokens: sql<number>`sum(${usageDayModels.tokens})::bigint`,
    })
    .from(usageDayModels)
    .innerJoin(accounts, eq(usageDayModels.accountId, accounts.id))
    .innerJoin(accountScopes, eq(accountScopes.accountId, usageDayModels.accountId))
    .where(modelFilter)
    .groupBy(usageDayModels.agent, usageDayModels.model);
  const allModels = modelRows
    .map((r) => ({ agent: r.agent, model: r.model, sessions: Number(r.sessions ?? 0), tokens: Number(r.tokens ?? 0) }))
    .sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model));
  const models = allModels.slice(0, MODELS_LIMIT);
  const agentMap = new Map<string, OrgUsageAgent>();
  for (const m of allModels) {
    const a = agentMap.get(m.agent) ?? { agent: m.agent, sessions: 0, tokens: 0 };
    a.sessions += m.sessions;
    a.tokens += m.tokens;
    agentMap.set(m.agent, a);
  }
  const agents = [...agentMap.values()].sort((a, b) => b.tokens - a.tokens);

  const totals = members.reduce(
    (t, m) => ({
      sessions: t.sessions + m.sessions, msgs: t.msgs + m.msgs,
      tokensIn: t.tokensIn + m.tokensIn, tokensOut: t.tokensOut + m.tokensOut, tokensCache: t.tokensCache + m.tokensCache,
      tokens: t.tokens + m.tokens, activeMs: t.activeMs + m.activeMs, activeDays: t.activeDays,
    }),
    { sessions: 0, msgs: 0, tokensIn: 0, tokensOut: 0, tokensCache: 0, tokens: 0, activeMs: 0, activeDays: daily.length },
  );

  return { scope, range, memberCount: members.length, totals, members, daily, models, agents };
}
