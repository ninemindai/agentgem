// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/console/src/panels/Observe/ContextTimeline.tsx
//
// Per-session context-window timeline (Inspect → Session): auto-fetches on
// session open and renders an SVG context-window chart alongside a rail with
// the hygiene verdict, fired factors, and the biggest context jumps. Claude-only,
// like DistillSection — the underlying scan reads Claude transcripts. Replaces
// the old HygieneReport component/block in TranscriptViewer, which has since
// been removed (the cross-session leaderboard lives in panels/Rubrics/).
import { useEffect, useState } from "react";
import { hygieneRoute, makeClient, type HygieneReport as Report } from "../../api/routes.js";
import { buildTimeline } from "./ctxTimeline.js";
import { CATEGORY_COLOR } from "./toolCategory.js";
import { fmtTokens } from "./data.js";

export function ContextTimeline({ apiBase, agent, sessionId }: { apiBase: string; agent: "claude" | "codex"; sessionId: string }) {
  const [rep, setRep] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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

  if (agent !== "claude") return null;
  if (loading) return <div className="obs hyg"><div className="obs-muted">Analyzing…</div></div>;
  if (error) return <div className="obs hyg"><div className="obs-error">{error}</div></div>;
  if (!rep || rep.curve.length === 0) return <div className="obs hyg"><div className="obs-muted">No context data for this session.</div></div>;

  const m = buildTimeline(rep.curve, rep.events, rep.meta.cap);
  const W = Math.max(560, m.n * 0.9), H = 300, PL = 48, PR = 10, PT = 14, PB = 34;
  const iw = W - PL - PR, ih = H - PT - PB;
  const X = (x: number) => PL + x * iw;
  const Y = (v: number) => PT + ih - (v / (m.ymax || 1)) * ih;

  return (
    <div className="obs ct">
      <div className="ct-chart">
        <div className="ct-scroll" style={{ overflowX: "auto" }}>
          <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label="Context window over the session">
            {rep.boundary && m.n > 1 && rep.boundary.segments.map((s, k) => (k % 2 === 1 ? (
              <rect key={`seg-${s.fromTurn}`} x={X(s.fromTurn / (m.n - 1))} y={PT}
                width={Math.max(1, X(s.toTurn / (m.n - 1)) - X(s.fromTurn / (m.n - 1)))} height={ih}
                fill="color-mix(in srgb, var(--muted) 8%, transparent)" />
            ) : null))}
            {[0.5, 0.8].map((f) => (
              <rect key={f} x={PL} y={Y(m.ymax)} width={iw} height={Y(f * m.ymax) - Y(m.ymax)}
                fill={f >= 0.8 ? "color-mix(in srgb, var(--red) 11%, transparent)" : "color-mix(in srgb, var(--amber) 9%, transparent)"} />
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
              <circle key={i} cx={X(mk.x)} cy={PT + 7} r={3} fill={mk.kind === "skill" ? CATEGORY_COLOR.skill : CATEGORY_COLOR.agent}
                aria-label={`${mk.kind}: ${mk.name}`} />
            ))}
            {rep.boundary?.cutTurn != null && m.n > 1 && (
              <line x1={X(rep.boundary.cutTurn / (m.n - 1))} y1={PT}
                x2={X(rep.boundary.cutTurn / (m.n - 1))} y2={PT + ih}
                stroke="var(--accent)" strokeWidth={1.5} strokeDasharray="3 2" aria-label={`suggested cut at turn ${rep.boundary.cutTurn}`} />
            )}
          </svg>
        </div>
      </div>
      <div className="ct-rail">
        <div className={"hyg-verdict is-" + rep.hygiene.verdict}>
          <span className="hyg-score">{fmtTokens(Math.max(...rep.curve.map((c) => c.ctxTokens)))}</span>
          <span className="hyg-word">{rep.hygiene.verdict}</span>
        </div>
        <div className="rail-h">Why — hygiene factors</div>
        <ul className="ct-facs">
          {rep.factors.filter((f) => f.count > 0).map((f) => (
            <li key={f.id}><b>{f.title}</b> <span className="obs-muted">×{f.count}</span><div className="obs-muted">{f.advice}</div></li>
          ))}
        </ul>
        <div className="rail-h">Biggest context jumps</div>
        {m.jumps.map((j, i) => (
          <div className="jump" key={i}>
            <div className="jbadge">+{fmtTokens(j.delta)}</div>
            <div className="jbody"><div className="t">turn {j.turn} · <span style={{ color: CATEGORY_COLOR[j.category] }}>{j.category}</span></div>
              <div className="obs-muted">{j.cause}</div></div>
          </div>
        ))}
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
