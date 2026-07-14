import { useCallback, useEffect, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import { Loading } from "../../shell/Loading.js";
import { listProviders, getOutbox, refreshOutbox, pushApproved, type ProviderRow, type Candidate } from "./api.js";
import { ProviderItem } from "./ProviderItem.js";

// Memory: connect/enable/test/pull external memory providers, then review and push the
// curation outbox (signals collected locally, approved before anything leaves the machine).
export function Memory({ apiBase }: { apiBase: string }) {
  const [providers, setProviders] = useState<ProviderRow[] | null>(null);
  const [outbox, setOutbox] = useState<Candidate[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadProviders = useCallback(() => {
    listProviders(apiBase).then((r) => setProviders(r.providers)).catch(() => setError("Could not load providers."));
  }, [apiBase]);
  const loadOutbox = useCallback(() => {
    getOutbox(apiBase).then((r) => setOutbox(r.candidates)).catch(() => setError("Could not load the outbox."));
  }, [apiBase]);

  useEffect(() => { loadProviders(); loadOutbox(); }, [loadProviders, loadOutbox]);

  const toggle = (key: string) =>
    setSelected((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });

  const doRefresh = async () => {
    setBusy(true); setError(null);
    try {
      const r = await refreshOutbox(apiBase);
      setOutbox(r.candidates);
      setSelected(new Set());
    } catch {
      setError("Could not refresh candidates.");
    } finally {
      setBusy(false);
    }
  };

  const doPush = async () => {
    if (selected.size === 0) return;
    setBusy(true); setError(null);
    try {
      await pushApproved(apiBase, [...selected]);
      setSelected(new Set());
      loadOutbox();
    } catch {
      setError("Push failed — try again.");
    } finally {
      setBusy(false);
    }
  };

  if (providers === null && !error) return <Loading />;

  return (
    <div className="memory">
      <section className="ledger-group">
        <h2 className="ledger-group-label">Memory providers</h2>
        {error && <p className="ledger-error">{error}</p>}
        <div className="ws-list">
          {(providers ?? []).map((p) => (
            <ProviderItem key={p.id} apiBase={apiBase} row={p} onChanged={loadProviders} />
          ))}
        </div>
      </section>

      <section className="ledger-group">
        <h2 className="ledger-group-label">Curation outbox</h2>
        <div className="ledger-selbar">
          <strong className="ledger-selcount">{selected.size} selected</strong>
          <button type="button" className="ledger-sort" disabled={busy} onClick={() => void doRefresh()}>Refresh candidates</button>
          <button type="button" className="ledger-build" disabled={busy || selected.size === 0} onClick={() => void doPush()}>Push approved</button>
        </div>
        {outbox && outbox.length === 0 ? (
          <p className="ledger-empty">No candidates.</p>
        ) : (
          <ul className="ledger-items">
            {(outbox ?? []).map((c) => (
              <li className="ledger-item-wrap" key={c.key}>
                <div className="ledger-item">
                  <label className="ledger-item-main">
                    <input type="checkbox" checked={selected.has(c.key)} onChange={() => toggle(c.key)} />
                    <span className="ledger-item-name">{c.text}</span>
                  </label>
                  <span className="ledger-source">{c.kind} · {c.source}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export const memoryPage = defineConsolePage({
  id: "memory",
  title: "Memory",
  icon: "🧠",
  order: 20,
  footer: true,
  route: "#/memory",
  component: ({ apiBase }) => <Memory apiBase={apiBase} />,
});
