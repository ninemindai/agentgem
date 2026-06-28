import { useEffect, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import {
  deployTargetsRoute, setCredentialRoute, CREDENTIAL_KEYS, makeClient,
} from "../../api/routes.js";

type Backend = { id: string; label: string; ready: boolean };

export function Settings({ apiBase }: { apiBase: string }) {
  const [targets, setTargets] = useState<Backend[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [credKey, setCredKey] = useState<(typeof CREDENTIAL_KEYS)[number]>(CREDENTIAL_KEYS[0]);
  const [credValue, setCredValue] = useState("");
  const [credNote, setCredNote] = useState<string | null>(null);

  useEffect(() => {
    deployTargetsRoute.call(makeClient(apiBase))
      .then((r) => setTargets(r.targets))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [apiBase]);

  const saveCredential = async () => {
    setCredNote(null);
    setError(null);
    try {
      const { ok } = await setCredentialRoute.call(makeClient(apiBase), { body: { key: credKey, value: credValue } });
      if (ok) { setCredNote(`saved ${credKey}`); setCredValue(""); }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="deploy">
      <section className="ledger-group">
        <h2 className="ledger-group-label">Credentials</h2>
        <div className="ledger-bar">
          <select className="targets-select" aria-label="credential key" value={credKey} onChange={(e) => setCredKey(e.target.value as (typeof CREDENTIAL_KEYS)[number])}>
            {CREDENTIAL_KEYS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <input className="ledger-search" type="password" aria-label="credential value" placeholder="value (stored in ~/.agentgem/.env)" value={credValue} onChange={(e) => setCredValue(e.target.value)} />
          <button type="button" className="ledger-build" disabled={!credValue.trim()} onClick={saveCredential}>Save</button>
          {credNote && <span className="ws-note">{credNote}</span>}
        </div>
      </section>

      <section className="ledger-group">
        <h2 className="ledger-group-label">Deploy backends</h2>
        {error && <p className="ledger-error">{error}</p>}
        {!targets ? <p className="ledger-loading">Loading…</p>
          : targets.length === 0 ? <p className="ledger-empty">No deploy backends.</p>
          : (
            <div className="ws-list">
              {targets.map((t) => (
                <article className="ws-card" key={t.id}>
                  <header className="ws-head">
                    <span className="ws-name">{t.label}</span>
                    <span className={"deploy-badge " + (t.ready ? "is-ready" : "is-unready")}>
                      {t.ready ? "ready" : "needs credentials"}
                    </span>
                  </header>
                  <p className="tb-path">{t.id}</p>
                </article>
              ))}
            </div>
          )}
        <p className="deploy-hint">Deploy a gem from the Workspaces panel once its backend shows “ready”.</p>
      </section>
    </div>
  );
}

export const settingsPage = defineConsolePage({
  id: "settings",
  title: "Settings",
  icon: "⚙",
  order: 10,
  group: "settings",
  route: "#/settings",
  component: ({ apiBase }) => <Settings apiBase={apiBase} />,
});
