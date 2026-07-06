// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/console/src/panels/Observe/HygieneReport.tsx
//
// Per-session context-hygiene report (Inspect → Session): auto-fetches on
// session open and renders a verdict badge, a bloat curve, and the fired
// hygiene factors. Claude-only, like DistillSection above — the underlying
// scan reads Claude transcripts.
import { useEffect, useRef, useState } from "react";
import { hygieneRoute, makeClient, type HygieneReport as Report } from "../../api/routes.js";

export function HygieneReport({ apiBase, agent, sessionId }: { apiBase: string; agent: "claude" | "codex"; sessionId: string }) {
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

  return (
    <div className="obs hyg">
      <div className="hyg-head">Context hygiene</div>
      {loading && <div className="obs-muted">Analyzing…</div>}
      {error && <div className="obs-error">{error}</div>}
      {rep && rep.curve.length === 0 && <div className="obs-muted">No context data for this session.</div>}
      {rep && rep.curve.length > 0 && (
        <>
          <div className={"hyg-verdict is-" + rep.hygiene.verdict}>
            <span className="hyg-score">{rep.hygiene.score}</span>
            <span className="hyg-word">{rep.hygiene.verdict}</span>
          </div>
          <BloatCurve curve={rep.curve} cap={rep.meta.cap} />
          <ul className="hyg-factors">
            {rep.factors.filter((f) => f.count > 0).map((f) => (
              <li key={f.id}><b>{f.title}</b> <span className="obs-muted">×{f.count}</span><div className="obs-muted">{f.advice}</div></li>
            ))}
          </ul>
          {rep.factors.every((f) => f.count === 0) && <div className="obs-muted">All {rep.factors.length} checks passed.</div>}
        </>
      )}
    </div>
  );
}

function BloatCurve({ curve, cap }: { curve: Report["curve"]; cap: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const ctx = cv.getContext("2d"); if (!ctx) return;
    const w = cv.width, h = cv.height, pad = 4;
    const css = (k: string) => getComputedStyle(document.documentElement).getPropertyValue(k).trim() || "#f0883e";
    const heat = css("--obs-accent");
    ctx.clearRect(0, 0, w, h);
    const N = curve.length;
    const X = (i: number) => pad + (w - 2 * pad) * (N > 1 ? i / (N - 1) : 0);
    const Y = (v: number) => h - pad - (h - 2 * pad) * Math.min(1, v / cap);
    ctx.beginPath(); ctx.moveTo(X(0), h - pad);
    curve.forEach((p, i) => ctx.lineTo(X(i), Y(p.ctxTokens)));
    ctx.lineTo(X(N - 1), h - pad); ctx.closePath();
    ctx.fillStyle = heat + "22"; ctx.fill();
    ctx.beginPath(); curve.forEach((p, i) => (i ? ctx.lineTo(X(i), Y(p.ctxTokens)) : ctx.moveTo(X(i), Y(p.ctxTokens))));
    ctx.strokeStyle = heat; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.strokeStyle = css("--obs-muted") || "#888"; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(pad, Y(cap)); ctx.lineTo(w - pad, Y(cap)); ctx.stroke(); ctx.setLineDash([]);
  }, [curve, cap]);
  return <canvas ref={ref} width={320} height={90} className="hyg-canvas" role="img" aria-label="Context size per turn" />;
}
