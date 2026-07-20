// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/usage/reporter.ts
//
// Scheduled usage reporting: the local process rolls its transcript scan into per-UTC-day
// usage rows and POSTs them to the aggregator (Bearer = the first-party session minted at
// `agentgem bind`). Signed-out or disabled machines skip silently — reporting is a side
// effect of being bound, never a requirement. Re-reports overwrite server-side (idempotent
// upsert per account/machine/day), so each pass simply re-sends the trailing window.
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join, dirname } from "node:path";
import { agentgemHome } from "@agentgem/model";
import { scanSessionsCached, type SessionStat } from "@agentgem/insight";
import { readSession, bindConfig } from "@agentgem/app/bind/bindCore";
import { createLogger } from "@agentgem/base";

const log = createLogger("usage");

export interface UsageDayRow { scope: string; date: string; sessions: number; msgs: number; tokensIn: number; tokensOut: number; tokensCache: number; activeMs: number }

const DAY_MS = 86_400_000;
export const REPORT_WINDOW_DAYS = 30;
export const REPORT_EVERY_MS = 6 * 60 * 60 * 1000; // at most one report per 6h, resent windows overwrite

const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// ── Repo-owner attribution ─────────────────────────────────────────────────────
// A session's usage is attributed to the OWNER of the repo it ran in (github.com/<owner>/…),
// derived locally from the repo's `remote "origin"` URL. This is the anti-leak boundary: the org
// dashboard only aggregates rows attributed to that org, so personal-repo and other-org work never
// shows up there. Sessions outside a repo (or with no remote) report scope "" (unattributed) and
// surface only on the reporter's own personal view.

/** Owner segment of a git remote URL: git@host:owner/repo.git | https://host/owner/repo(.git) |
 *  ssh://git@host/owner/repo. Lowercased (GitHub logins are case-insensitive). Pure. */
export function ownerFromRemoteUrl(url: string): string {
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?[^:/]+[:/]([^/]+)\/[^/]+?(?:\.git)?\/?$/i.exec(url.trim());
  return m ? m[1].toLowerCase() : "";
}

/** Resolve the repo-owner scope for a session cwd by walking up to the repo's .git and reading
 *  `remote "origin"`'s url from its config. Worktree-aware (.git FILE → gitdir → main .git/config).
 *  Returns "" when the cwd is gone, outside a repo, or has no parseable remote. Injected fs for tests. */
export function scopeForCwd(
  cwd: string | null | undefined,
  fs: { readFile: (p: string) => string | null; isDir: (p: string) => boolean } = defaultScopeFs,
): string {
  if (!cwd) return "";
  let dir = cwd;
  for (let depth = 0; depth < 20; depth++) {
    const dotGit = join(dir, ".git");
    let configPath: string | null = null;
    if (fs.isDir(dotGit)) {
      configPath = join(dotGit, "config");
    } else {
      const gitFile = fs.readFile(dotGit); // worktree/submodule: `.git` is a file "gitdir: <path>"
      const gitdir = gitFile ? /^gitdir:\s*(.+)\s*$/m.exec(gitFile)?.[1] : undefined;
      if (gitdir) {
        const abs = gitdir.startsWith("/") ? gitdir : join(dir, gitdir);
        const wt = /(.*\/\.git)\/worktrees\/[^/]+\/?$/.exec(abs); // <main>/.git/worktrees/<name>
        configPath = join(wt ? wt[1] : abs, "config");
      }
    }
    if (configPath) {
      const config = fs.readFile(configPath) ?? "";
      const origin = /\[remote "origin"\][^[]*?url\s*=\s*(.+)/.exec(config);
      return origin ? ownerFromRemoteUrl(origin[1]) : "";
    }
    const parent = dirname(dir);
    if (parent === dir) return "";
    dir = parent;
  }
  return "";
}

const defaultScopeFs = {
  readFile: (p: string): string | null => { try { return readFileSync(p, "utf8"); } catch { return null; } },
  isDir: (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } },
};

/** Bucket a transcript scan into per-(repo-owner scope, UTC day) rollups (a session lands on its
 *  END day). scopeOf is injected for tests; results are cached per distinct cwd. Pure given scopeOf. */
export function usageDaysFromStats(stats: SessionStat[], sinceMs: number, scopeOf: (cwd: string | null | undefined) => string = scopeForCwd): UsageDayRow[] {
  const byKey = new Map<string, UsageDayRow>();
  const scopeCache = new Map<string, string>();
  for (const s of stats) {
    if (s.endMs < sinceMs) continue;
    const cwd = s.cwd ?? "";
    let scope = scopeCache.get(cwd);
    if (scope === undefined) { scope = scopeOf(s.cwd); scopeCache.set(cwd, scope); }
    const date = utcDate(s.endMs);
    const key = scope + "\n" + date;
    const row = byKey.get(key) ?? { scope, date, sessions: 0, msgs: 0, tokensIn: 0, tokensOut: 0, tokensCache: 0, activeMs: 0 };
    row.sessions += 1;
    row.msgs += s.msgs;
    row.tokensIn += s.tokensIn;
    row.tokensOut += s.tokensOut;
    row.tokensCache += s.tokensCache;
    row.activeMs += Math.max(0, s.endMs - s.startMs);
    byKey.set(key, row);
  }
  return [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date) || a.scope.localeCompare(b.scope));
}

export interface UsageModelRow { scope: string; date: string; agent: string; model: string; sessions: number; tokens: number }

/** Bucket the scan into per-(scope, day, agent, model) slices — the "By Model" breakdown. Same
 *  attribution + end-day rules as usageDaysFromStats. Sessions with no model land on "". */
export function usageModelsFromStats(stats: SessionStat[], sinceMs: number, scopeOf: (cwd: string | null | undefined) => string = scopeForCwd): UsageModelRow[] {
  const byKey = new Map<string, UsageModelRow>();
  const scopeCache = new Map<string, string>();
  for (const s of stats) {
    if (s.endMs < sinceMs) continue;
    const cwd = s.cwd ?? "";
    let scope = scopeCache.get(cwd);
    if (scope === undefined) { scope = scopeOf(s.cwd); scopeCache.set(cwd, scope); }
    const date = utcDate(s.endMs);
    const agent = s.agent ?? "";
    const model = s.model ?? "";
    const key = [scope, date, agent, model].join("\n");
    const row = byKey.get(key) ?? { scope, date, agent, model, sessions: 0, tokens: 0 };
    row.sessions += 1;
    row.tokens += s.tokensIn + s.tokensOut + s.tokensCache;
    byKey.set(key, row);
  }
  return [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date) || a.scope.localeCompare(b.scope) || a.model.localeCompare(b.model));
}

const statePath = (home: string) => join(home, ".agentgem", "usage-report.json");

export function readReportState(home: string): { lastReportAt?: string } {
  try { return JSON.parse(readFileSync(statePath(home), "utf8")) as { lastReportAt?: string }; } catch { return {}; }
}

function writeReportState(home: string, lastReportAt: string): void {
  try {
    mkdirSync(join(home, ".agentgem"), { recursive: true, mode: 0o700 });
    writeFileSync(statePath(home), JSON.stringify({ lastReportAt }), { mode: 0o600 });
  } catch { /* best-effort — a failed state write only means an extra report later */ }
}

export type ReportOutcome =
  | { ok: true; recorded: number }
  | { ok: false; reason: "disabled" | "signed-out" | "throttled" | "no-usage" | string };

export interface ReportDeps {
  home?: string;
  now?: number;
  fetchImpl?: typeof fetch;
  scan?: (nowMs: number) => Promise<SessionStat[]>;
  session?: typeof readSession;
  base?: string;
  machine?: string;
  force?: boolean; // manual `agentgem usage report` skips the 6h throttle
  fullHistory?: boolean; // --backfill: report every day in the transcripts, not just the 30-day window
}

// The server caps one report at 400 day-rows and 2000 model-rows (normalizeUsageReport /
// normalizeUsageModels). The normal 30-day window fits easily; a full-history backfill can
// exceed both, so batches are split and sent as multiple idempotent POSTs.
const DAYS_PER_POST = 400;
const MODELS_PER_POST = 2000;

const chunk = <T>(arr: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

/** Chunk model rows WITHOUT splitting a (scope, date) group across POSTs: the server replaces
 *  each group it receives wholesale (stale-slice purge), so a group straddling two requests
 *  would have its first half deleted by the second. Groups are tiny (agents × models per
 *  scope-day), so a soft cap works; a single oversized group still ships alone. */
export function chunkModelRows(models: UsageModelRow[], size: number): UsageModelRow[][] {
  const out: UsageModelRow[][] = [];
  let current: UsageModelRow[] = [];
  let i = 0;
  while (i < models.length) {
    // take the whole (scope, date) group
    let j = i + 1;
    while (j < models.length && models[j].scope === models[i].scope && models[j].date === models[i].date) j++;
    const group = models.slice(i, j);
    if (current.length > 0 && current.length + group.length > size) {
      out.push(current);
      current = [];
    }
    current.push(...group);
    i = j;
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** One reporting pass: scan → bucket → POST (chunked to the server's per-request caps).
 *  Never throws; returns why it was skipped. `fullHistory` drops the 30-day window and
 *  re-sends every day found in the local transcripts (the --backfill path) — safe because
 *  the server upserts per (machine, scope, day), so a backfill converges, never double-counts. */
export async function reportUsageOnce(deps: ReportDeps = {}): Promise<ReportOutcome> {
  if (process.env.AGENTGEM_USAGE_DISABLE === "1") return { ok: false, reason: "disabled" };
  const home = deps.home ?? agentgemHome();
  const now = deps.now ?? Date.now();
  const session = (deps.session ?? readSession)(now);
  if (!session) return { ok: false, reason: "signed-out" };
  if (!deps.force) {
    const last = Date.parse(readReportState(home).lastReportAt ?? "");
    if (Number.isFinite(last) && now - last < REPORT_EVERY_MS) return { ok: false, reason: "throttled" };
  }
  const stats = await (deps.scan ?? ((n: number) => scanSessionsCached(n)))(now);
  const sinceMs = deps.fullHistory ? 0 : now - REPORT_WINDOW_DAYS * DAY_MS;
  const days = usageDaysFromStats(stats, sinceMs);
  if (days.length === 0) return { ok: false, reason: "no-usage" };
  const models = usageModelsFromStats(stats, sinceMs);
  const base = deps.base ?? bindConfig().base ?? "https://api.agentgem.ai";
  const machine = deps.machine ?? hostname();
  try {
    // Pair up day- and model-chunks into requests; the two arrays are independent server-side,
    // so any batch failure just leaves earlier (already-upserted) batches in place — the next
    // run re-sends and converges.
    const dayChunks = chunk(days, DAYS_PER_POST);
    const modelChunks = chunkModelRows(models, MODELS_PER_POST);
    let recorded = 0;
    for (let i = 0; i < Math.max(dayChunks.length, modelChunks.length); i++) {
      const res = await (deps.fetchImpl ?? fetch)(new URL("/api/usage/report", base), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.sessionToken}` },
        // A models-only tail batch still needs a non-empty days array to pass validation —
        // resend the last day-chunk's final row (idempotent overwrite, no effect).
        body: JSON.stringify({ machine, days: dayChunks[i] ?? [days[days.length - 1]], models: modelChunks[i] ?? [] }),
      });
      if (!res.ok) return { ok: false, reason: `http-${res.status}` };
      const out = (await res.json()) as { recorded?: number };
      recorded += out.recorded ?? (dayChunks[i]?.length ?? 0);
    }
    writeReportState(home, new Date(now).toISOString());
    return { ok: true, recorded };
  } catch (err) {
    return { ok: false, reason: (err as Error)?.message ?? "network" };
  }
}

export interface UsageReporter { stop(): void }

/** Background schedule: try once at start (throttle-gated), then every interval. The timer is
 *  unref'd so it never keeps a shutting-down process alive. */
export function startUsageReporter(deps: ReportDeps & { intervalMs?: number } = {}): UsageReporter {
  const intervalMs = deps.intervalMs ?? REPORT_EVERY_MS;
  const pass = () => void reportUsageOnce(deps).then((r) => {
    if (r.ok) log.info("usage report: %d day(s) sent", r.recorded);
    else if (r.reason !== "throttled" && r.reason !== "no-usage") log.debug("usage report skipped: %s", r.reason);
  });
  pass();
  const t = setInterval(pass, intervalMs);
  t.unref?.();
  return { stop() { clearInterval(t); } };
}

/** `agentgem usage report [--backfill]` — manual, un-throttled push; prints the outcome.
 *  --backfill re-sends the FULL local history (all transcript days), for first-time setup or a
 *  machine that was offline past the 30-day window. Idempotent: re-running never double-counts. */
export async function runUsageCommand(argv: string[], deps: ReportDeps = {}): Promise<number> {
  if (argv[0] !== "report") {
    console.error("agentgem usage: use `agentgem usage report [--backfill]` to push usage rollups now");
    return 1;
  }
  const fullHistory = argv.includes("--backfill");
  const out = await reportUsageOnce({ ...deps, force: true, fullHistory });
  if (out.ok) { console.log(`agentgem usage: ${fullHistory ? "backfilled" : "reported"} ${out.recorded} day-row(s)`); return 0; }
  if (out.reason === "signed-out") { console.error("agentgem usage: not signed in — run `agentgem bind` first"); return 1; }
  if (out.reason === "disabled") { console.error("agentgem usage: reporting is disabled (AGENTGEM_USAGE_DISABLE=1)"); return 1; }
  if (out.reason === "no-usage") { console.log(`agentgem usage: no local sessions ${fullHistory ? "found" : "in the last 30 days"} — nothing to report`); return 0; }
  console.error(`agentgem usage: report failed (${out.reason})`);
  return 1;
}
