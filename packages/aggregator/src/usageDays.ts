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

/** REPLACE-BY-GROUP per-(agent, model) day slices: a report is authoritative for every
 *  (scope, day) group it covers, so all existing slices in those groups are deleted first.
 *  A plain upsert is NOT enough here — a session's last-seen model can change between two
 *  reports of the same day, moving it to a different (agent, model) key; the stale key's row
 *  would survive an upsert and double-count that session in every slice-derived view. The
 *  reporter keeps each group intact within one POST (group-aware chunking), so a partial
 *  batch never wipes a group it doesn't fully re-send. */
export async function recordUsageModels(db: AppDb, accountId: string, machine: string, models: UsageModelReport[]): Promise<{ recorded: number }> {
  const groups = new Map<string, { scope: string; date: string }>();
  for (const m of models) {
    const scope = m.scope ?? "";
    groups.set(`${scope}\n${m.date}`, { scope, date: m.date });
  }
  for (const g of groups.values()) {
    await db.delete(usageDayModels).where(and(
      eq(usageDayModels.accountId, accountId),
      eq(usageDayModels.machine, machine),
      eq(usageDayModels.scope, g.scope),
      eq(usageDayModels.date, g.date),
    ));
  }
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
  // Filter options for the current scope/range/member view, computed WITHOUT the agent/model
  // filters so the selectors always show every choice (not just the currently-selected one).
  facets: { agents: string[]; models: string[] };
  // True when an agent/model filter re-aggregated the payload from the per-model slices — those
  // carry only sessions + total tokens, so msgs/duration/token-split fields are zeroed and the
  // UI should hide the metrics that don't exist in a filtered view.
  filtered: boolean;
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
 *  their personal view. `agent`/`model` filter the WHOLE payload by re-aggregating from the
 *  per-model slices (usage_day_models) — sessions + total tokens only; the day-rollup metrics
 *  (msgs, duration, token split) have no per-model dimension and are zeroed (`filtered: true`). */
export async function buildOrgUsage(
  db: AppDb, scope: string, range: OrgUsageRange, nowMs: number = Date.now(),
  opts: { includeUnattributed?: boolean; memberLogin?: string; agent?: string; model?: string } = {},
): Promise<OrgUsage> {
  const cutoff = rangeCutoff(range, nowMs);
  const scopeLc = scope.toLowerCase();
  const filtered = Boolean(opts.agent || opts.model);
  // Case-insensitive like the scope filter: GitHub logins are case-insensitive, and a hand-typed
  // ?member=Octocat must not render a false-empty view when the stored login is "octocat".
  const memberOnly = opts.memberLogin ? sql`lower(${accounts.login}) = ${opts.memberLogin.toLowerCase()}` : undefined;

  // Shared filter for the per-model slice table (facets, models list, and — when an agent/model
  // filter is active — the members/daily aggregations too).
  const modelBase = and(
    eq(accountScopes.scope, scope),
    opts.includeUnattributed ? sql`${usageDayModels.scope} in (${scopeLc}, '')` : eq(usageDayModels.scope, scopeLc),
    cutoff === null ? undefined : gte(usageDayModels.date, cutoff),
    memberOnly,
  );
  const facetCond = and(
    modelBase,
    opts.agent ? eq(usageDayModels.agent, opts.agent) : undefined,
    opts.model ? eq(usageDayModels.model, opts.model) : undefined,
  );
  const modelJoins = <T extends { innerJoin: any }>(q: T) => q
    .innerJoin(accounts, eq(usageDayModels.accountId, accounts.id))
    .innerJoin(accountScopes, eq(accountScopes.accountId, usageDayModels.accountId));

  let members: OrgUsageMember[];
  let daily: OrgUsageDay[];
  if (!filtered) {
    const dayFilter = and(
      eq(accountScopes.scope, scope),
      opts.includeUnattributed ? sql`${usageDays.scope} in (${scopeLc}, '')` : eq(usageDays.scope, scopeLc),
      cutoff === null ? undefined : gte(usageDays.date, cutoff),
      memberOnly,
    );
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
      .where(dayFilter)
      .groupBy(accounts.id, accounts.login, accounts.avatarUrl);
    // pglite/pg drivers return bigint sums as strings — coerce every aggregate to number.
    members = memberRows.map((r) => {
      const tokensIn = Number(r.tokensIn ?? 0), tokensOut = Number(r.tokensOut ?? 0), tokensCache = Number(r.tokensCache ?? 0);
      return {
        login: r.login, avatarUrl: r.avatarUrl,
        sessions: Number(r.sessions ?? 0), msgs: Number(r.msgs ?? 0),
        tokensIn, tokensOut, tokensCache, tokens: tokensIn + tokensOut + tokensCache,
        activeMs: Number(r.activeMs ?? 0), activeDays: Number(r.activeDays ?? 0),
        lastActive: r.lastActive ?? null,
      };
    });
    const dailyRows = await db
      .select({
        date: usageDays.date,
        sessions: sql<number>`sum(${usageDays.sessions})::int`,
        tokens: sql<number>`(sum(${usageDays.tokensIn}) + sum(${usageDays.tokensOut}) + sum(${usageDays.tokensCache}))::bigint`,
      })
      .from(usageDays)
      .innerJoin(accounts, eq(usageDays.accountId, accounts.id))
      .innerJoin(accountScopes, eq(accountScopes.accountId, usageDays.accountId))
      .where(dayFilter)
      .groupBy(usageDays.date)
      .orderBy(usageDays.date);
    daily = dailyRows.map((r) => ({ date: r.date, sessions: Number(r.sessions ?? 0), tokens: Number(r.tokens ?? 0) }));
  } else {
    // Agent/model filter active: the day rollups have no model dimension, so members and daily
    // both re-aggregate from the slices. Only sessions + tokens exist here; the rest is zeroed.
    const memberRows = await modelJoins(db
      .select({
        login: accounts.login,
        avatarUrl: accounts.avatarUrl,
        sessions: sql<number>`sum(${usageDayModels.sessions})::int`,
        tokens: sql<number>`sum(${usageDayModels.tokens})::bigint`,
        activeDays: sql<number>`count(distinct ${usageDayModels.date})::int`,
        lastActive: sql<string | null>`max(${usageDayModels.date})`,
      })
      .from(usageDayModels))
      .where(facetCond)
      .groupBy(accounts.id, accounts.login, accounts.avatarUrl);
    members = memberRows.map((r: Record<string, unknown>) => ({
      login: String(r.login), avatarUrl: (r.avatarUrl as string | null) ?? null,
      sessions: Number(r.sessions ?? 0), msgs: 0,
      tokensIn: 0, tokensOut: 0, tokensCache: 0, tokens: Number(r.tokens ?? 0),
      activeMs: 0, activeDays: Number(r.activeDays ?? 0),
      lastActive: (r.lastActive as string | null) ?? null,
    }));
    const dailyRows = await modelJoins(db
      .select({
        date: usageDayModels.date,
        sessions: sql<number>`sum(${usageDayModels.sessions})::int`,
        tokens: sql<number>`sum(${usageDayModels.tokens})::bigint`,
      })
      .from(usageDayModels))
      .where(facetCond)
      .groupBy(usageDayModels.date)
      .orderBy(usageDayModels.date);
    daily = dailyRows.map((r: Record<string, unknown>) => ({ date: String(r.date), sessions: Number(r.sessions ?? 0), tokens: Number(r.tokens ?? 0) }));
  }
  members.sort((a, b) => b.tokens - a.tokens || a.login.localeCompare(b.login));

  // Facet basis: every (agent, model) slice for the current scope/range/member view, WITHOUT the
  // agent/model filters — this feeds the selector options and (when unfiltered) the models list.
  const facetRows = await modelJoins(db
    .select({
      agent: usageDayModels.agent,
      model: usageDayModels.model,
      sessions: sql<number>`sum(${usageDayModels.sessions})::int`,
      tokens: sql<number>`sum(${usageDayModels.tokens})::bigint`,
    })
    .from(usageDayModels))
    .where(modelBase)
    .groupBy(usageDayModels.agent, usageDayModels.model);
  const allSlices: OrgUsageModel[] = facetRows
    .map((r: Record<string, unknown>) => ({ agent: String(r.agent), model: String(r.model), sessions: Number(r.sessions ?? 0), tokens: Number(r.tokens ?? 0) }))
    .sort((a: OrgUsageModel, b: OrgUsageModel) => b.tokens - a.tokens || a.model.localeCompare(b.model));
  // Agent options never narrow (switching agents must always be possible); MODEL options cascade
  // under a selected agent — offering another agent's models would only build guaranteed-empty
  // agent+model combinations.
  const facets = {
    agents: [...new Set(allSlices.map((m) => m.agent).filter(Boolean))],
    models: [...new Set(allSlices.filter((m) => !opts.agent || m.agent === opts.agent).map((m) => m.model).filter(Boolean))],
  };

  const visibleSlices = filtered
    ? allSlices.filter((m) => (!opts.agent || m.agent === opts.agent) && (!opts.model || m.model === opts.model))
    : allSlices;
  const models = visibleSlices.slice(0, MODELS_LIMIT);
  const agentMap = new Map<string, OrgUsageAgent>();
  for (const m of visibleSlices) {
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

  return { scope, range, memberCount: members.length, totals, members, daily, models, agents, facets, filtered };
}
