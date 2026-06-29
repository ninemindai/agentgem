/** Pure formatting + chart-math for the Insights panel. */

import type { AggIngredient } from "../../api/routes.js";

export interface PrettyId { name: string; scope?: string }
export interface RankedRow { row: AggIngredient; rank: number }

/** Public ingredient ids are self-describing — strip the prefix into name (+ scope). */
export function prettifyId(id: string, _kind: string): PrettyId {
  const colon = id.indexOf(":");
  if (colon <= 0) return { name: id }; // model / harness / registry @scope/... — show as-is
  const prefix = id.slice(0, colon);
  const rest = id.slice(colon + 1);
  if (prefix === "skill" || prefix === "mcp") {
    const slash = rest.indexOf("/");
    return slash > 0 ? { name: rest.slice(slash + 1), scope: rest.slice(0, slash) } : { name: rest };
  }
  if (prefix === "url") return { name: rest, scope: "url" };
  return { name: rest, scope: prefix }; // package runner (npx:, uvx:, …)
}

const KIND_LABELS: Record<string, string> = { skill: "Skill", mcp: "MCP", model: "Model", harness: "Harness" };
export function kindLabel(kind: string): string { return KIND_LABELS[kind] ?? kind; }

export function verifiedShare(producers: number, verified: number): number {
  return producers > 0 ? Math.min(1, verified / producers) : 0;
}

export function barWidths(values: number[]): number[] {
  if (values.length === 0) return [];
  const max = Math.max(1, ...values);
  return values.map((v) => v / max);
}

/** Space-separated "x,y" points for an SVG polyline; y inverted so taller = bigger.
 *  `max` lets a verified series share the producers' scale for overlay. */
export function sparkPoints(values: number[], w: number, h: number, max = Math.max(1, ...values)): string {
  if (values.length === 0) return "";
  if (values.length === 1) { const y = (h - (values[0] / max) * h).toFixed(0); return `0,${y} ${w},${y}`; }
  const step = w / (values.length - 1);
  return values.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`).join(" ");
}

/** Filter the leaderboard by a case-insensitive substring over name/scope/raw id.
 *  Rank is the row's 1-based position in the full (unfiltered) list, so ranks stay honest. */
export function filterRows(rows: AggIngredient[], query: string): RankedRow[] {
  const q = query.trim().toLowerCase();
  const ranked = rows.map((row, i) => ({ row, rank: i + 1 }));
  if (q === "") return ranked;
  return ranked.filter(({ row }) => {
    const p = prettifyId(row.id, row.kind);
    return (
      p.name.toLowerCase().includes(q) ||
      (p.scope?.toLowerCase().includes(q) ?? false) ||
      row.id.toLowerCase().includes(q)
    );
  });
}
