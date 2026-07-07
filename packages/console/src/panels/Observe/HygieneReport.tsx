// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/console/src/panels/Observe/HygieneReport.tsx
//
// Per-session context-hygiene report (Inspect → Session): auto-fetches on
// session open and renders a verdict badge, a bloat curve, and the fired
// hygiene factors. Claude-only, like DistillSection above — the underlying
// scan reads Claude transcripts.
import { useEffect, useState } from "react";
import { hygieneRoute, makeClient, type HygieneReport as Report } from "../../api/routes.js";
import { BloatCurve } from "../_shared/BloatCurve.js";

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
