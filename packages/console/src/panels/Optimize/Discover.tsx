// packages/console/src/panels/Optimize/Discover.tsx
import { useState } from "react";
import { discoverRoute, rerankDiscoverRoute, installSkillRoute, makeClient, type DiscoverPayload, type DiscoverCandidate } from "../../api/routes.js";
import { ListControls } from "../../shell/ListControls.js";
import { useSelectableList } from "../../shell/useSelectableList.js";

type InstallPhase = "idle" | "installing" | "done" | "error";
interface InstallState { phase: InstallPhase; message: string }

export function DiscoverSection({ apiBase }: { apiBase: string }) {
  const [data, setData] = useState<DiscoverPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [reranking, setReranking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-candidate install status, keyed by url — shared by single and batch installs.
  const [status, setStatus] = useState<Record<string, InstallState>>({});
  // Candidates awaiting a confirm before install runs (single row → [c], batch → selected).
  const [pending, setPending] = useState<DiscoverCandidate[] | null>(null);

  const candidates = data?.candidates ?? [];
  const list = useSelectableList(candidates, {
    keyOf: (c) => c.url,
    matches: (c, q) => c.name.toLowerCase().includes(q) || c.source.toLowerCase().includes(q) || c.reason.toLowerCase().includes(q),
  });

  const find = () => {
    setLoading(true); setError(null);
    discoverRoute.call(makeClient(apiBase), {})
      .then((d) => { setData(d); setStatus({}); setPending(null); list.clear(); })
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

  const st = (url: string): InstallState => status[url] ?? { phase: "idle", message: "" };
  // Install each candidate sequentially (the `skills` CLI mutates ~/.claude — parallel
  // runs would race). Already-installed rows are skipped so a batch is safely re-runnable.
  const runInstall = async (cands: DiscoverCandidate[]) => {
    for (const c of cands) {
      if (st(c.url).phase === "done") continue;
      setStatus((s) => ({ ...s, [c.url]: { phase: "installing", message: "" } }));
      try {
        const r = await installSkillRoute.call(makeClient(apiBase), { body: { source: c.source, skillId: c.skillId } });
        setStatus((s) => ({ ...s, [c.url]: { phase: r.ok ? "done" : "error", message: r.message } }));
      } catch (e) {
        setStatus((s) => ({ ...s, [c.url]: { phase: "error", message: String((e as Error)?.message ?? e) } }));
      }
    }
  };
  const confirmInstall = () => { const cands = pending ?? []; setPending(null); void runInstall(cands); };

  const stats = Object.values(status);
  const installing = stats.some((s) => s.phase === "installing");
  const doneCount = stats.filter((s) => s.phase === "done").length;
  const failedCount = stats.filter((s) => s.phase === "error").length;
  const summary = installing || doneCount || failedCount
    ? `${installing ? "installing… · " : ""}${doneCount} installed${failedCount ? `, ${failedCount} failed` : ""}`
    : null;

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
          <p className="obs-muted opt-note">Install runs the <code>skills</code> CLI with <code>--global</code> on this machine (into your <code>~/.claude</code> skills). Install counts are <strong>registry-reported</strong>, not AgentGem endorsements.</p>
          <ListControls
            query={list.query} onQuery={list.setQuery} label="filter skills"
            placeholder="Filter by name, source, or reason…"
            selectLabel={list.allSelected ? "Deselect all" : `Select all (${list.eligibleVisible.length})`}
            onSelectAll={list.toggleAll} selectDisabled={list.eligibleVisible.length === 0}
            actions={
              <>
                <button className="obs-range-btn" onClick={() => setPending(list.selectedItems())} disabled={list.selected.size === 0 || pending !== null || installing}>
                  {`Install selected (${list.selected.size})`}
                </button>
                {summary && <span className="opt-sel-savings">{summary}</span>}
              </>
            }
          />
          {pending && (
            <div className="opt-disc-actions">
              <span className="obs-muted">Install {pending.length} skill{pending.length === 1 ? "" : "s"} to ~/.claude (global)?</span>
              <button className="obs-range-btn" onClick={confirmInstall}>Confirm</button>
              <button className="opt-copy-cmd" onClick={() => setPending(null)}>Cancel</button>
            </div>
          )}
          <table className="obs-table">
            <thead><tr><th></th><th>skill</th><th>source</th><th>installs</th><th>why</th><th>install</th></tr></thead>
            <tbody>
              {list.filtered.length === 0 && (
                <tr><td colSpan={6} className="obs-muted">No skills match this filter.</td></tr>
              )}
              {list.filtered.map((c) => (
                <tr key={c.url}>
                  <td><input type="checkbox" aria-label={`select ${c.name}`} checked={list.isSelected(c)} onChange={() => list.toggle(c)} /></td>
                  <td><a href={c.url} target="_blank" rel="noreferrer">{c.name}</a></td>
                  <td className="obs-muted">{c.source}</td>
                  <td className="obs-muted">{c.installs != null ? c.installs.toLocaleString() : "—"}</td>
                  <td className="obs-muted">{c.reason}</td>
                  <td><InstallCell state={st(c.url)} cmd={c.installCmd} onInstall={() => setPending([c])} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

function InstallCell({ state, cmd, onInstall }: { state: InstallState; cmd: string; onInstall: () => void }) {
  return (
    <div className="opt-install">
      {state.phase === "idle" && (
        <button type="button" className="obs-range-btn" onClick={onInstall} title="Install this skill to your machine">Install</button>
      )}
      {state.phase === "installing" && <span className="obs-muted">Installing…</span>}
      {state.phase === "done" && <span className="opt-install-ok" title={state.message}>✓ installed</span>}
      {state.phase === "error" && (
        <span className="opt-install-err">
          <span className="obs-error" title={state.message}>✗ {state.message.split("\n").slice(-1)[0] || "failed"}</span>
          <button type="button" className="opt-copy-cmd" onClick={onInstall}>retry</button>
        </span>
      )}
      <CopyCmd cmd={cmd} />
    </div>
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
