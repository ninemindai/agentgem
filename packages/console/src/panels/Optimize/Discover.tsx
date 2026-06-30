// packages/console/src/panels/Optimize/Discover.tsx
import { useState } from "react";
import { discoverRoute, rerankDiscoverRoute, makeClient, type DiscoverPayload } from "../../api/routes.js";

export function DiscoverSection({ apiBase }: { apiBase: string }) {
  const [data, setData] = useState<DiscoverPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [reranking, setReranking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const find = () => {
    setLoading(true); setError(null);
    discoverRoute.call(makeClient(apiBase), {})
      .then(setData)
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => setLoading(false));
  };
  const rerank = () => {
    if (!data) return;
    setReranking(true); setError(null);
    rerankDiscoverRoute.call(makeClient(apiBase), { body: { candidates: data.candidates, topics: data.topics } })
      .then(setData)
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => setReranking(false));
  };

  return (
    <section className="opt-section">
      <h3>Discover — recommended for you <span className="obs-muted">from skills.sh, matched to your workflows</span></h3>
      <div className="opt-disc-actions">
        <button className="obs-range-btn" onClick={find} disabled={loading}>{loading ? "Finding…" : data ? "Refresh" : "Find recommendations"}</button>
        {data && data.candidates.length > 1 && (
          <button className="obs-range-btn" onClick={rerank} disabled={reranking} title="Uses a local AI agent (token-costing)">
            {reranking ? "Re-ranking…" : "Re-rank with AI"}
          </button>
        )}
        {data?.reranked && <span className="obs-muted">AI-ranked</span>}
      </div>

      {error && <p className="obs-error">{error}</p>}
      {data?.degraded && <p className="obs-muted opt-note">{data.degraded.reason}</p>}

      {data && data.candidates.length > 0 && (
        <>
          <p className="obs-muted opt-note">Recommend-only — nothing is installed for you. Install counts are <strong>registry-reported</strong>, not AgentGem endorsements.</p>
          <table className="obs-table">
            <thead><tr><th>skill</th><th>source</th><th>installs</th><th>why</th><th>install</th></tr></thead>
            <tbody>
              {data.candidates.map((c) => (
                <tr key={c.url}>
                  <td><a href={c.url} target="_blank" rel="noreferrer">{c.name}</a></td>
                  <td className="obs-muted">{c.source}</td>
                  <td className="obs-muted">{c.installs != null ? c.installs.toLocaleString() : "—"}</td>
                  <td className="obs-muted">{c.reason}</td>
                  <td><CopyCmd cmd={c.installCmd} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

function CopyCmd({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { void navigator.clipboard?.writeText(cmd); setCopied(true); setTimeout(() => setCopied(false), 1600); };
  return (
    <button type="button" className="opt-copy-cmd" onClick={copy} title="Copy install command">
      <code>{cmd}</code><span className="obs-muted">{copied ? " ✓" : " ⧉"}</span>
    </button>
  );
}
