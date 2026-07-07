// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/console/src/panels/Observe/ProcessQualityReport.tsx
//
// Per-session process-quality report (Inspect → Session): auto-fetches on
// session open and renders the AgentLens-style score/label, an intent-stage
// bar, and the fired detector findings. Claude-only, like HygieneReport — the
// underlying analysis reads the Claude tool-verb spine.
import { useEffect, useState } from "react";
import { processRoute, makeClient, type SessionSummary } from "../../api/routes.js";

const STAGE_KEYS = ["exploration", "implementation", "verification", "orchestration"] as const;

export function ProcessQualityReport({ apiBase, agent, sessionId }: { apiBase: string; agent: "claude" | "codex"; sessionId: string }) {
  const [sum, setSum] = useState<SessionSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (agent !== "claude") return;
    let alive = true;
    setLoading(true); setError(null); setSum(null);
    processRoute.call(makeClient(apiBase), { query: { id: sessionId, agent } })
      .then((r) => { if (alive) setSum(r); })
      .catch((e) => { if (alive) setError(String(e?.message ?? e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [apiBase, agent, sessionId]);

  if (agent !== "claude") return null;

  return (
    <div className="obs pq">
      <div className="pq-head">Process quality</div>
      {loading && <div className="obs-muted">Analyzing…</div>}
      {error && <div className="obs-error">{error}</div>}
      {sum && !sum.process && <div className="obs-muted">No process data for this session.</div>}
      {sum && sum.process && (
        <>
          <div className={"pq-verdict is-" + sum.process.label}>
            <span className="pq-score">{sum.process.score}</span>
            <span className="pq-word">{sum.process.label}</span>
          </div>
          <StageBar stages={sum.process.stages} />
          {sum.findings.length > 0 ? (
            <ul className="pq-factors">
              {sum.findings.map((f) => (
                <li key={f.id}><b>{f.title}</b> <span className="obs-muted">×{f.count}</span><div className="obs-muted">{f.advice}</div></li>
              ))}
            </ul>
          ) : <div className="obs-muted">No process issues detected.</div>}
        </>
      )}
    </div>
  );
}

function StageBar({ stages }: { stages: NonNullable<SessionSummary["process"]>["stages"] }) {
  const total = STAGE_KEYS.reduce((n, k) => n + stages[k], 0);
  if (total === 0) return null;
  return (
    <div className="pq-stagebar" role="img" aria-label="Intent-stage mix">
      {STAGE_KEYS.map((k) => {
        const pct = (stages[k] / total) * 100;
        return pct > 0 ? <div key={k} className={"pq-stage is-" + k} style={{ width: `${pct}%` }} title={`${k}: ${stages[k]}`} /> : null;
      })}
    </div>
  );
}
