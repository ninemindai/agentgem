import type { DailyPoint } from "../../api/routes.js";

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return Math.round(n / 1_000) + "k";
  return String(n);
}

export function fmtDuration(ms: number): string {
  const s = ms / 1000;
  if (s >= 3600) return (s / 3600).toFixed(1).replace(/\.0$/, "") + "h";
  if (s >= 60) return Math.round(s / 60) + "m";
  return Math.round(s) + "s";
}

export function tokenSeries(daily: DailyPoint[]): { date: string; in: number; out: number; cache: number }[] {
  return daily.map((d) => ({ date: d.date, in: d.tokensIn, out: d.tokensOut, cache: d.tokensCache }));
}

/** Local date+time for a session boundary, compact. */
export function fmtTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Flame intensity 0\u20133 for a session's tokens relative to the busiest visible session. */
export function flameLevel(tokens: number, maxTokens: number): 0 | 1 | 2 | 3 {
  if (maxTokens <= 0) return 0;
  const r = tokens / maxTokens;
  if (r >= 0.75) return 3;
  if (r >= 0.4) return 2;
  if (r >= 0.15) return 1;
  return 0;
}

/** A calendar-heatmap cell: the day, its activity counts, and a 0\u20134 intensity level. */
export interface HeatCell { date: string; sessions: number; tokens: number; level: 0 | 1 | 2 | 3 | 4; weekday: number; week: number }

/** Turn daily points into heatmap cells. `level` buckets `sessions` against the max in the set.
 *  `weekday` = UTC day-of-week (0=Sun). `week` = integer week index from the earliest date (for column layout). */
export function heatmapCells(daily: DailyPoint[]): HeatCell[] {
  if (daily.length === 0) return [];
  const maxSessions = Math.max(1, ...daily.map((d) => d.sessions));
  const parse = (date: string) => Date.parse(date + "T00:00:00.000Z");
  const first = Math.min(...daily.map((d) => parse(d.date)));
  const firstSunday = first - (new Date(first).getUTCDay()) * 86_400_000;
  return daily.map((d) => {
    const ms = parse(d.date);
    const weekday = new Date(ms).getUTCDay();
    const week = Math.floor((ms - firstSunday) / (7 * 86_400_000));
    const r = d.sessions / maxSessions;
    const level = (d.sessions === 0 ? 0 : r >= 0.75 ? 4 : r >= 0.5 ? 3 : r >= 0.25 ? 2 : 1) as HeatCell["level"];
    return { date: d.date, sessions: d.sessions, tokens: d.tokensIn + d.tokensOut + d.tokensCache, level, weekday, week };
  });
}
