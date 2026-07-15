// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/console/src/panels/Observe/ContextTimeline.tsx
//
// Per-session context-window timeline (∿ Context lens in the structure toggle):
// fetches on mount and renders an SVG context-window chart alongside a rail with
// the hygiene verdict, fired factors, and the biggest context jumps. Claude-only,
// like DistillSection — the underlying scan reads Claude transcripts. Replaces
// the old HygieneReport component/block in TranscriptViewer, which has since
// been removed (the cross-session leaderboard lives in panels/Rubrics/).
import { useRef, useEffect, useState } from "react";
import { hygieneRoute, makeClient, type HygieneReport as Report } from "../../api/routes.js";
import { buildTimeline } from "./ctxTimeline.js";
import { CATEGORY_COLOR } from "./toolCategory.js";
import { fmtTokens } from "./data.js";
import { useSplit } from "../../shell/useSplit.js";

// Round tick steps so axis labels land on clean token counts.
function tickStep(ymax: number): number {
  const raw = ymax / 4;
  const pow = 10 ** Math.floor(Math.log10(raw || 1));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= raw) return m * pow;
  return 10 * pow;
}

export function ContextTimeline({ apiBase, agent, sessionId, onOpenTurn }: {
  apiBase: string; agent: "claude" | "codex"; sessionId: string;
  // Spike → transcript join: called with the curve point's msgIndex (raw JSONL
  // line); the host resolves it to a turn and deep-links (?turn=<n>).
  onOpenTurn?: (msgIndex: number) => void;
}) {
  const [rep, setRep] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hover, setHover] = useState<number | null>(null);   // curve index under the cursor
  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    if (agent !== "claude") return;
    let alive = true;
    setLoading(true); setError(null); setRep(null);
    hygieneRoute.call(makeClient(apiBase), { query: { id: sessionId, agent } })
      .then((r) => { if (alive) setRep(r); })
      .catch((e) => { if (alive) setError(String(e?.message ?? e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [apiBase, agent, sessionId]);

  // Hook must run before the early returns below (rules of hooks); the aside
  // (.ct-rail) is the resizable pane, so side:"end".
  const split = useSplit("hygiene", { initial: 288, min: 240, max: 460, side: "end" });

  if (agent !== "claude") return null;
  if (loading) return <div className="obs hyg"><div className="obs-muted">Analyzing…</div></div>;
  if (error) return <div className="obs hyg"><div className="obs-error">{error}</div></div>;
  if (!rep || rep.curve.length === 0) return <div className="obs hyg"><div className="obs-muted">No context data for this session.</div></div>;

  const m = buildTimeline(rep.curve, rep.events, rep.meta.cap);
  const W = Math.max(560, m.n * 0.9), H = 300, PL = 48, PR = 10, PT = 14, PB = 34;
  const iw = W - PL - PR, ih = H - PT - PB;
  const X = (x: number) => PL + x * iw;
  const Y = (v: number) => PT + ih - (v / (m.ymax || 1)) * ih;

  const peak = Math.max(...rep.curve.map((c) => c.ctxTokens));
  const capPct = Math.round((peak / rep.meta.cap) * 100);
  const step = tickStep(m.ymax);
  const ticks: number[] = [];
  for (let v = step; v <= m.ymax; v += step) ticks.push(v);

  // Danger bands anchor to the MODEL CAP, not the chart max: 80% of a 1M cap is
  // the real pressure line. When the session never gets near the cap the bands
  // simply fall outside the chart and the rail's headroom line tells the story.
  const bands = [
    { at: 0.8 * rep.meta.cap, fill: "color-mix(in srgb, var(--red) 11%, transparent)" },
    { at: 0.5 * rep.meta.cap, fill: "color-mix(in srgb, var(--amber) 9%, transparent)" },
  ].filter((b) => b.at < m.ymax);

  const onMove = (clientX: number) => {
    const el = svgRef.current;
    if (!el || m.n < 2) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0) return;
    const fx = ((clientX - r.left) / r.width) * W;
    const i = Math.round(((fx - PL) / iw) * (m.n - 1));
    setHover(Math.max(0, Math.min(m.n - 1, i)));
  };
  const hovered = hover !== null ? rep.curve[hover] : null;

  return (
    <div
      className={"obs ct" + (split.containerProps.className ? " " + split.containerProps.className : "")}
      style={split.containerProps.style}
    >
      <div className="ct-chart">
        <div className="ct-scroll" style={{ overflowX: "auto" }}>
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img"
            aria-label="Context window over the session"
            onMouseMove={(e) => onMove(e.clientX)}
            onMouseLeave={() => setHover(null)}
            onClick={() => { if (onOpenTurn && hover !== null) onOpenTurn(rep.curve[hover].msgIndex); }}
            style={onOpenTurn ? { cursor: "pointer" } : undefined}
          >
            {rep.boundary && m.n > 1 && rep.boundary.segments.map((s, k) => (k % 2 === 1 ? (
              <rect key={`seg-${s.fromTurn}`} x={X(s.fromTurn / (m.n - 1))} y={PT}
                width={Math.max(1, X(s.toTurn / (m.n - 1)) - X(s.fromTurn / (m.n - 1)))} height={ih}
                fill="color-mix(in srgb, var(--muted) 8%, transparent)" />
            ) : null))}
            {bands.map((b) => (
              <rect key={b.at} x={PL} y={Y(m.ymax)} width={iw} height={Y(b.at) - Y(m.ymax)} fill={b.fill} />
            ))}
            {ticks.map((v) => (
              <g key={v}>
                <line x1={PL} y1={Y(v)} x2={W - PR} y2={Y(v)} stroke="color-mix(in srgb, var(--muted) 18%, transparent)" strokeWidth={0.75} />
                <text x={PL - 6} y={Y(v) + 3} textAnchor="end" className="ct-tick">{fmtTokens(v)}</text>
              </g>
            ))}
            <path d={`M ${X(0)} ${Y(m.points[0].ctx)} ` + m.points.map((p) => `L ${X(p.x)} ${Y(p.ctx)}`).join(" ") + ` L ${X(1)} ${Y(0)} L ${X(0)} ${Y(0)} Z`}
              fill="color-mix(in srgb, var(--blue) 18%, transparent)" />
            <path d={`M ${X(0)} ${Y(m.points[0].ctx)} ` + m.points.map((p) => `L ${X(p.x)} ${Y(p.ctx)}`).join(" ")}
              fill="none" stroke="var(--blue)" strokeWidth={1.5} />
            {m.markers.map((mk, i) => (
              // aria-label (not a nested <title>) so the marker's accessible name
              // doesn't collide with the same name shown in the rail's jump list —
              // a nested <title> text node and the rail text both match on a plain
              // substring query, which makes "the jump names the skill" ambiguous.
              // Shapes disambiguate without color: ◆ skill, ▲ subagent.
              mk.kind === "skill" ? (
                <path key={i} d={`M ${X(mk.x)} ${PT + 3} l 4 4 l -4 4 l -4 -4 Z`} fill={CATEGORY_COLOR.skill}
                  aria-label={`skill: ${mk.name}`} />
              ) : (
                <path key={i} d={`M ${X(mk.x)} ${PT + 3} l 4.5 8 h -9 Z`} fill={CATEGORY_COLOR.agent}
                  aria-label={`agent: ${mk.name}`} />
              )
            ))}
            {rep.boundary?.cutTurn != null && m.n > 1 && (
              <line x1={X(rep.boundary.cutTurn / (m.n - 1))} y1={PT}
                x2={X(rep.boundary.cutTurn / (m.n - 1))} y2={PT + ih}
                stroke="var(--accent)" strokeWidth={1.5} strokeDasharray="3 2" aria-label={`suggested cut at turn ${rep.boundary.cutTurn}`} />
            )}
            {hovered && m.n > 1 && (
              <g pointerEvents="none">
                <line x1={X(hover! / (m.n - 1))} y1={PT} x2={X(hover! / (m.n - 1))} y2={PT + ih}
                  stroke="color-mix(in srgb, var(--ink) 35%, transparent)" strokeWidth={1} />
                <circle cx={X(hover! / (m.n - 1))} cy={Y(hovered.ctxTokens)} r={3} fill="var(--blue)" />
              </g>
            )}
          </svg>
        </div>
        <div className="ct-readout obs-muted" aria-live="polite">
          {hovered
            ? <>turn {hovered.turn} · context {fmtTokens(hovered.ctxTokens)} · out {fmtTokens(hovered.outTokens)}{hovered.cacheCreation > 0 && <> · +{fmtTokens(hovered.cacheCreation)} new</>}{onOpenTurn && <> · click to open in transcript</>}</>
            : <>peak {fmtTokens(peak)} of {fmtTokens(rep.meta.cap)} cap ({capPct}%) — hover for per-turn detail</>}
        </div>
      </div>
      {split.handle}
      <div className="ct-rail">
        <div className={"hyg-verdict is-" + rep.hygiene.verdict}>
          <span className="hyg-score">{fmtTokens(peak)}</span>
          <span className="hyg-word">{rep.hygiene.verdict}</span>
        </div>
        <div className="rail-h">Why — hygiene factors</div>
        <ul className="ct-facs">
          {rep.factors.filter((f) => f.count > 0).map((f) => (
            <li key={f.id}><b>{f.title}</b> <span className="obs-muted">×{f.count}</span><div className="obs-muted">{f.advice}</div></li>
          ))}
        </ul>
        <div className="rail-h">Biggest context jumps</div>
        {m.jumps.map((j, i) => {
          const body = (
            <>
              <div className="jbadge">+{fmtTokens(j.delta)}</div>
              <div className="jbody"><div className="t">turn {j.turn} · <span style={{ color: CATEGORY_COLOR[j.category] }}>{j.category}</span>{onOpenTurn && <span className="jump-open"> ↗</span>}</div>
                <div className="obs-muted">{j.cause}</div></div>
            </>
          );
          return onOpenTurn ? (
            <button type="button" className="jump jump-btn" key={i} onClick={() => onOpenTurn(j.msgIndex)}
              aria-label={`open turn ${j.turn} in the transcript`}>{body}</button>
          ) : (
            <div className="jump" key={i}>{body}</div>
          );
        })}
        {rep.boundary && (
          <>
            <div className="rail-h">Task areas — where to cut</div>
            <p className="obs-muted">
              Looked like {rep.boundary.segments.length} task areas
              {rep.boundary.cutTurn != null ? ` — a clean break around turn ${rep.boundary.cutTurn} keeps each window lean.` : "."}
            </p>
            <ul className="ct-episodes">
              {rep.boundary.segments.map((s) => (
                <li key={s.fromTurn}><span className="mono">{s.fromTurn}–{s.toTurn}</span> {s.label}</li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
