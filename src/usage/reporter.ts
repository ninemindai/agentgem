// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/usage/reporter.ts
//
// Scheduled usage reporting: the local process rolls its transcript scan into per-UTC-day
// usage rows and POSTs them to the aggregator (Bearer = the first-party session minted at
// `agentgem bind`). Signed-out or disabled machines skip silently — reporting is a side
// effect of being bound, never a requirement. Re-reports overwrite server-side (idempotent
// upsert per account/machine/day), so each pass simply re-sends the trailing window.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { agentgemHome } from "@agentgem/model";
import { scanSessionsCached, type SessionStat } from "@agentgem/insight";
import { readSession, bindConfig } from "../bind/bindCore.js";
import { createLogger } from "@agentgem/base";

const log = createLogger("usage");

export interface UsageDayRow { date: string; sessions: number; msgs: number; tokensIn: number; tokensOut: number; tokensCache: number; activeMs: number }

const DAY_MS = 86_400_000;
export const REPORT_WINDOW_DAYS = 30;
export const REPORT_EVERY_MS = 6 * 60 * 60 * 1000; // at most one report per 6h, resent windows overwrite

const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Bucket a transcript scan into per-UTC-day rollups (a session lands on its END day). Pure. */
export function usageDaysFromStats(stats: SessionStat[], sinceMs: number): UsageDayRow[] {
  const byDay = new Map<string, UsageDayRow>();
  for (const s of stats) {
    if (s.endMs < sinceMs) continue;
    const date = utcDate(s.endMs);
    const row = byDay.get(date) ?? { date, sessions: 0, msgs: 0, tokensIn: 0, tokensOut: 0, tokensCache: 0, activeMs: 0 };
    row.sessions += 1;
    row.msgs += s.msgs;
    row.tokensIn += s.tokensIn;
    row.tokensOut += s.tokensOut;
    row.tokensCache += s.tokensCache;
    row.activeMs += Math.max(0, s.endMs - s.startMs);
    byDay.set(date, row);
  }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
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
}

/** One reporting pass: scan → bucket → POST. Never throws; returns why it was skipped. */
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
  const days = usageDaysFromStats(stats, now - REPORT_WINDOW_DAYS * DAY_MS);
  if (days.length === 0) return { ok: false, reason: "no-usage" };
  const base = deps.base ?? bindConfig().base ?? "https://api.agentgem.ai";
  try {
    const res = await (deps.fetchImpl ?? fetch)(new URL("/api/usage/report", base), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.sessionToken}` },
      body: JSON.stringify({ machine: deps.machine ?? hostname(), days }),
    });
    if (!res.ok) return { ok: false, reason: `http-${res.status}` };
    const out = (await res.json()) as { recorded?: number };
    writeReportState(home, new Date(now).toISOString());
    return { ok: true, recorded: out.recorded ?? days.length };
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

/** `agentgem usage report` — manual, un-throttled push; prints the outcome. */
export async function runUsageCommand(argv: string[], deps: ReportDeps = {}): Promise<number> {
  if (argv[0] !== "report") {
    console.error("agentgem usage: use `agentgem usage report` to push usage rollups now");
    return 1;
  }
  const out = await reportUsageOnce({ ...deps, force: true });
  if (out.ok) { console.log(`agentgem usage: reported ${out.recorded} day(s)`); return 0; }
  if (out.reason === "signed-out") { console.error("agentgem usage: not signed in — run `agentgem bind` first"); return 1; }
  if (out.reason === "disabled") { console.error("agentgem usage: reporting is disabled (AGENTGEM_USAGE_DISABLE=1)"); return 1; }
  if (out.reason === "no-usage") { console.log("agentgem usage: no local sessions in the last 30 days — nothing to report"); return 0; }
  console.error(`agentgem usage: report failed (${out.reason})`);
  return 1;
}
