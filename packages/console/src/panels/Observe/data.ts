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
