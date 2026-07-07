import type { HygieneReport } from "../../api/routes.js";
import { type ToolCategory } from "./toolCategory.js";

export interface Marker { x: number; kind: "skill" | "agent"; name: string }
export interface Jump { turn: number; delta: number; ctx: number; cause: string; category: ToolCategory }
export interface TimelineModel {
  n: number; ymax: number;
  points: { x: number; ctx: number; out: number }[];
  markers: Marker[];
  jumps: Jump[];
}

export function buildTimeline(curve: HygieneReport["curve"], events: HygieneReport["events"], cap: number): TimelineModel {
  const n = curve.length;
  const empty: TimelineModel = { n, ymax: 0, points: [], markers: [], jumps: [] };
  if (n < 2) return { ...empty, points: curve.map((p, i) => ({ x: n <= 1 ? 0 : i / (n - 1), ctx: p.ctxTokens, out: p.outTokens })) };

  const peak = Math.max(...curve.map((p) => p.ctxTokens));
  const ymax = Math.min(cap, Math.ceil(peak / 50_000) * 50_000) || peak;
  const xOf = (i: number) => i / (n - 1);
  const points = curve.map((p, i) => ({ x: xOf(i), ctx: p.ctxTokens, out: p.outTokens }));

  // markers: map each event's msgIndex to the nearest curve point index.
  const idxByMsg = curve.map((p) => p.msgIndex);
  const nearest = (msgIndex: number) => {
    let best = 0, bd = Infinity;
    idxByMsg.forEach((mi, i) => { const d = Math.abs(mi - msgIndex); if (d < bd) { bd = d; best = i; } });
    return best;
  };
  const markers: Marker[] = events.map((e) => ({ x: xOf(nearest(e.msgIndex)), kind: e.kind, name: e.name }));

  // jumps: top 4 positive ctx deltas; cause from an event on that point, else cache-creation.
  const evByPoint = new Map<number, HygieneReport["events"][number]>();
  events.forEach((e) => evByPoint.set(nearest(e.msgIndex), e));
  const rows: Jump[] = [];
  for (let i = 1; i < n; i++) {
    const delta = curve[i].ctxTokens - curve[i - 1].ctxTokens;
    if (delta <= 0) continue;
    const e = evByPoint.get(i);
    let cause: string, category: ToolCategory;
    if (e?.kind === "skill") { cause = `loaded skill ${e.name}`; category = "skill"; }
    else if (e?.kind === "agent") { cause = `subagent ${e.name} folded back`; category = "agent"; }
    else if (curve[i].cacheCreation > 8000) { cause = `context injection (+${Math.round(curve[i].cacheCreation / 1000)}k new)`; category = "other"; }
    else { cause = "model output"; category = "other"; }
    rows.push({ turn: curve[i].turn, delta, ctx: curve[i].ctxTokens, cause, category });
  }
  rows.sort((a, b) => b.delta - a.delta);
  return { n, ymax, points, markers, jumps: rows.slice(0, 4) };
}
